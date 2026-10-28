import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Card, CardDraft, CardLink, CardType } from '../domain/types.ts';
import { isCardType } from '../domain/types.ts';
import { fileExistsTaken, generateId } from '../domain/id.ts';
import { cardText, serializeCard, withCardText } from '../domain/card.ts';
import {
  LOCKED_MESSAGE,
  UNDELETABLE_MESSAGE,
  type Rumination,
  checkFleetingHasNoLinks,
  checkLinks,
  checkRelMatrix,
  checkThinkingHasTag,
  ruminationOf,
  setTaskMark,
  validateDraft,
  validateLinkOrder,
} from '../domain/rules.ts';
import {
  cardExists,
  cardPath,
  cardsDir,
  deleteCardFile,
  readCard,
  writeCardContent,
} from '../store/files.ts';
import type { CardIndex } from '../store/index/index.ts';
import type { GitBackup } from '../store/backup.ts';
import { NO_BASE, blobHash, cardObjectName, type CorpusStore } from '../store/remote.ts';
import { withWriteLock } from './lock.ts';

/**
 * 建立與修改卡片。
 *
 * 這是唯一一個知道「一次寫入由哪幾件事構成」的地方：
 * 先存進真相（有遠端時是 bucket，沒有時就是本機檔案）、再寫本機檔案、
 * 投影到索引、最後排一次備份。順序與失敗的處理方式只在這裡定義一次，
 * 路由不重複一遍。
 */

export interface CardServiceDeps {
  corpusPath: string;
  index: CardIndex;
  git: GitBackup;
  /** 遠端存放處。NO_STORE 時本機檔案就是真相。 */
  store: CorpusStore;
  logger: { error(msg: string): void };
  /** 反芻期長度，毫秒。來自 config（R5）。 */
  editWindowMs: number;
}

/** 遠端存不進去時說的話。這次寫入什麼都沒發生，表單裡的內容要留著。 */
export const STORE_UNAVAILABLE_MESSAGE =
  '暫時存不進去，這次沒有寫入。內容還留在表單裡，稍後再送一次。';

/**
 * 這張卡的反芻狀態。
 *
 * 規則本身是純的（domain 的 ruminationOf），但它需要兩個外部事實：
 * 設定裡的窗口長度，與「有沒有人指向這張卡」。前者在 config，後者在索引，
 * 而規則那一層兩個都不能碰。所以綁定只在這裡做一次——
 * 路由、模板、寫入路徑三處問的是同一個答案，不各自算一遍。
 */
export function ruminationFor(
  deps: Pick<CardServiceDeps, 'index' | 'editWindowMs'>,
  card: { id: string; created: string; type: string },
  now?: number,
): Rumination {
  return ruminationOf(card, {
    windowMs: deps.editWindowMs,
    cited: deps.index.isCited(card.id),
    now,
  });
}

/**
 * 這張卡現在的內容，濃縮成一個短字串。
 *
 * 頁面載入時拿一份，送出時帶回來比對——對不上就是這段時間裡別處改過它
 * （另一台裝置的編輯頁、另一個分頁的勾選）。舊的那頁照樣存下去的話，
 * 會無聲蓋掉那次修改；勾選的話，序號可能已經指到別的項目。
 *
 * 只算使用者寫得到的那幾樣。連結不算：它只增不減，兩邊各加各的不會互相蓋掉。
 * 內文去掉首尾空白再算，因為索引裡那一份與檔案裡那一份在首尾不一定逐字相同
 * （見 routes 的 body_md），而首尾的空白不會讓第 k 個標記換人。
 * 卡片頁從索引算、寫入路徑從檔案算，兩邊因此算得出同一個值。
 */
export function contentRev(card: {
  title: string;
  tags: readonly string[];
  url: string | null;
  body: string;
}): string {
  return createHash('sha1')
    .update(JSON.stringify([card.title, card.tags, card.url, card.body.trim()]))
    .digest('hex')
    .slice(0, 16);
}

/** 頁面帶回來的 rev 跟現在對不上時說的話。 */
export const CONFLICT_MESSAGE = '這張卡在別的地方改過了，重新載入之後再試一次。';

/** `unavailable`：遠端存不進去，什麼都沒寫（503）。 */
export type CreateResult =
  | { ok: true; card: Card }
  | { ok: false; errors: string[]; unavailable?: true };

/**
 * 修改失敗分四種：窗口已關（不可回復）、內容不合格（改了再送就行）、
 * 頁面過期（別處改過，重新載入再說）、遠端存不進去（稍後再送）。
 */
export type UpdateResult =
  | { ok: true; card: Card }
  | { ok: false; reason: 'locked' | 'invalid' | 'conflict' | 'unavailable'; errors: string[] };

/**
 * 表單送上來、還沒有 ID 的東西經過驗證之後落地。
 * 連結的順序規則需要本卡 ID，所以驗證分兩段，中間夾著發號。
 */
export function createCard(deps: CardServiceDeps, draft: CardDraft): Promise<CreateResult> {
  return withWriteLock(deps.corpusPath, () => createNow(deps, draft));
}

async function createNow(deps: CardServiceDeps, draft: CardDraft): Promise<CreateResult> {
  const checked = validateDraft(draft, {
    cardExists: (id) => cardExists(deps.corpusPath, id),
    typeOf: (id) => cardTypeOf(deps, id),
  });
  if (!checked.value) return { ok: false, errors: checked.errors };

  const id = generateId(fileExistsTaken(cardsDir(deps.corpusPath)));

  const orderErrors = validateLinkOrder(id, checked.value.links);
  if (orderErrors.length > 0) return { ok: false, errors: orderErrors };

  const card: Card = {
    id,
    type: checked.value.type,
    created: new Date().toISOString(),
    title: checked.value.title,
    tags: checked.value.tags,
    url: checked.value.url,
    provenance: checked.value.provenance,
    source_author: checked.value.source_author,
    source_date: checked.value.source_date,
    revised: null,
    links: checked.value.links,
    body: draft.body.replace(/\r\n/g, '\n'),
  };

  if (!(await persist(deps, card, 'add'))) {
    return { ok: false, errors: [STORE_UNAVAILABLE_MESSAGE], unavailable: true };
  }
  return { ok: true, card };
}

/**
 * 時窗內的修改。欄位一律「沒給就是不動」，
 * 所以呼叫端只需要送真的被改過的那幾個。
 */
export interface UpdatePatch {
  title?: string;
  tags?: string[];
  /** 空字串代表清掉這個欄位。 */
  url?: string;
  body?: string;
  /**
   * R7：要新增的連結。
   *
   * 這裡**沒有**「完整的 links」這個欄位，而且不會有——「只增不減」因此
   * 不需要靠比對來守，它就是這個型別的形狀：刪除沒有表示法。
   * 收整份再 diff 的話，那條規則會變成一段可能寫錯的比對程式碼，
   * 而寫錯的樣子是一條連結無聲消失。
   */
  addLinks?: { rel?: string; to?: string }[];
  /**
   * 編輯頁載入時那一份 contentRev。對不上就不寫（409）。
   * 沒帶的請求（API、測試）不檢查——它們沒有「載入時」可言。
   */
  rev?: string;
}

export function updateCard(
  deps: CardServiceDeps,
  id: string,
  patch: UpdatePatch,
): Promise<UpdateResult> {
  return withWriteLock(deps.corpusPath, () => updateNow(deps, id, patch));
}

async function updateNow(
  deps: CardServiceDeps,
  id: string,
  patch: UpdatePatch,
): Promise<UpdateResult> {
  const existing = readCard(deps.corpusPath, id);
  if (!ruminationFor(deps, existing).open) {
    return { ok: false, reason: 'locked', errors: [LOCKED_MESSAGE] };
  }
  if (patch.rev !== undefined && patch.rev !== contentRev(existing)) {
    return { ok: false, reason: 'conflict', errors: [CONFLICT_MESSAGE] };
  }

  // 可改的只有這四個欄位。類型、連結、id、created 不接受任何形式的修改。
  const title = (patch.title ?? existing.title).trim();
  if (title === '') return { ok: false, reason: 'invalid', errors: ['標題不得為空'] };

  let tags = existing.tags;
  if (patch.tags !== undefined) {
    tags = patch.tags.map((t) => t.trim());
    if (tags.some((t) => t === '')) {
      return { ok: false, reason: 'invalid', errors: ['標籤不得為空'] };
    }
    tags = [...new Set(tags)];
  }

  // R11：修改視同建立（R4 的但書），不能把思考的標籤刪到一個不剩。
  const untagged = checkThinkingHasTag(existing.type, tags);
  if (untagged.length > 0) return { ok: false, reason: 'invalid', errors: untagged };

  const url = pickUrl(existing.url, patch.url);

  // R7 的新增跟其他欄位的修改走同一次寫入：一次儲存就該是一個 commit。
  let links = existing.links;
  if (patch.addLinks && patch.addLinks.length > 0) {
    const appended = appendLinks(deps, existing, patch.addLinks);
    if ('errors' in appended) return { ok: false, reason: 'invalid', errors: appended.errors };
    links = appended.links;
  }

  const updated: Card = {
    ...existing,
    title,
    tags,
    links,
    url,
    revised: new Date().toISOString(),
    body: (patch.body === undefined ? existing.body : patch.body).replace(/\r\n/g, '\n'),
  };

  if (!(await persist(deps, updated, 'edit'))) {
    return { ok: false, reason: 'unavailable', errors: [STORE_UNAVAILABLE_MESSAGE] };
  }
  return { ok: true, card: updated };
}

/**
 * R7：反芻期內要新增的連結，驗過之後接在既有的後面。
 *
 * 新增的每一條都要通過**當下的**現行規則（R3 的 rel 與目標型別、目標存在且
 * ID 較小、同 rel 同目標不得重複）。既有的連結一條都不重驗——R4 說規則不追溯，
 * 而且它們當初已經驗過一次。R1 也不必重驗：既有的沒動，
 * 「重述有沒有 about 指向 original」的答案不可能因為新增而變壞。
 */
function appendLinks(
  deps: CardServiceDeps,
  existing: Card,
  raw: { rel?: string; to?: string }[],
): { links: CardLink[] } | { errors: string[] } {
  const type = existing.type;

  // R8：碎片不得有連結，R2 優先。先擋，否則會逐條報「這條哪裡不對」，
  // 而真正的問題是「它不該有連結」。
  const notAllowed = isCardType(type)
    ? checkFleetingHasNoLinks(type, existing.links.length + raw.length)
    : [];
  if (notAllowed.length > 0) return { errors: notAllowed };

  const checked = checkLinks(
    raw,
    { cardExists: (t) => cardExists(deps.corpusPath, t) },
    existing.links,
  );
  if (checked.errors.length > 0) return { errors: checked.errors };

  const errors = [
    ...validateLinkOrder(existing.id, checked.links),
    ...(isCardType(type) ? checkRelMatrix(type, checked.links, (t) => cardTypeOf(deps, t)) : []),
  ];
  if (errors.length > 0) return { errors };

  return { links: [...existing.links, ...checked.links] };
}

export type DeleteResult = { ok: true } | { ok: false; errors: string[]; unavailable?: true };

/**
 * R9：反芻期內、且尚未被任何卡片指向的卡片可以刪除。
 *
 * 兩個條件不必分開判——R6 已經把「被指向」折進反芻狀態裡，所以
 * `open === true` 就同時代表兩件事。三處判斷收斂成一個判準，這是 R6 的重點。
 *
 * 這不是方便功能，是 R7 的必要配套：連結只增不減，若連整張卡都不能刪，
 * 一次手滑就永久留在語料庫裡。
 *
 * 順序跟寫入路徑相反但理由相同：檔案是唯一真相，所以最後再動它？不——
 * 還是先動檔案。索引刪失敗可以重建，檔案還在才是不一致的那一種；
 * 反過來則會留下一張索引查得到、檔案已經不見的卡。
 * 有遠端時，遠端是真相，所以最先動它；它刪不掉，就什麼都不動。
 */
export function deleteCard(deps: CardServiceDeps, id: string): Promise<DeleteResult> {
  return withWriteLock(deps.corpusPath, () => deleteNow(deps, id));
}

async function deleteNow(deps: CardServiceDeps, id: string): Promise<DeleteResult> {
  const existing = readCard(deps.corpusPath, id);
  if (!ruminationFor(deps, existing).open) {
    return { ok: false, errors: [UNDELETABLE_MESSAGE] };
  }

  try {
    await deps.store.delete(cardObjectName(id));
  } catch (err) {
    deps.logger.error(`遠端刪除失敗 ${id}: ${errText(err)}`);
    return { ok: false, errors: [STORE_UNAVAILABLE_MESSAGE], unavailable: true };
  }

  deleteCardFile(deps.corpusPath, id);
  try {
    deps.index.removeCard(id);
  } catch (err) {
    deps.logger.error(
      `索引刪除失敗 ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  deps.git.commitCard(id, 'rm');
  return { ok: true };
}

export type ToggleResult =
  | { ok: true; card: Card; rev: string }
  | { ok: false; reason: 'conflict' | 'invalid' | 'unavailable'; errors: string[] };

/**
 * R14：切換一個勾選標記。不問反芻期，也不問定案——勾選不算修改。
 *
 * `at` 是標記在那段文字裡的位置，由路由用解析器算好（web/render.ts 的
 * taskMarks）。這一層不能碰 render，所以收的是位置，不是序號。
 *
 * 跟修改分開的兩件事：不更新 `revised`（那個欄位記的是內容的修訂），
 * commit 的動作是 `check`。其餘照一般的寫入路徑走：寫檔、索引、一個 commit。
 */
export function toggleTask(
  deps: CardServiceDeps,
  id: string,
  opts: { at: number; checked: boolean; rev: string },
): Promise<ToggleResult> {
  return withWriteLock(deps.corpusPath, () => toggleNow(deps, id, opts));
}

async function toggleNow(
  deps: CardServiceDeps,
  id: string,
  opts: { at: number; checked: boolean; rev: string },
): Promise<ToggleResult> {
  const existing = readCard(deps.corpusPath, id);
  if (opts.rev !== contentRev(existing)) {
    return { ok: false, reason: 'conflict', errors: [CONFLICT_MESSAGE] };
  }

  const before = cardText(existing);
  const after = setTaskMark(before, opts.at, opts.checked);
  if (after === null) return { ok: false, reason: 'invalid', errors: ['那裡沒有勾選標記'] };
  if (after === before) return { ok: true, card: existing, rev: contentRev(existing) };

  const updated = withCardText(existing, after);
  if (!(await persist(deps, updated, 'check'))) {
    return { ok: false, reason: 'unavailable', errors: [STORE_UNAVAILABLE_MESSAGE] };
  }
  return { ok: true, card: updated, rev: contentRev(updated) };
}

function pickUrl(current: string | null, given: string | undefined): string | null {
  if (given === undefined) return current;
  const v = given.trim();
  return v === '' ? null : v;
}

/**
 * 先存進真相，再寫本機檔案。回傳 false 代表遠端存不進去，這次什麼都沒寫。
 *
 * 有遠端時，**遠端回應成功才算存好**：本機的 /tmp 只是副本，機器換掉就沒了。
 * 上傳時記下這份內容改自哪一份（本機原本那份的 blob 雜湊），
 * 對帳時靠它分辨「bucket 比 git 新」與「bucket 是舊的」，見 store/reconcile.ts。
 * 新卡要求物件還不存在：ID 萬一撞了，寧可失敗也不覆蓋別張卡。
 *
 * 沒有遠端時，本機檔案就是真相，所以先寫檔——跟以前一樣。
 * 索引寫失敗不往上丟：檔案已經在了，索引隨時可以重建。
 * 備份是 fire-and-forget，不會擋住任何一條寫入路徑。
 */
async function persist(
  deps: CardServiceDeps,
  card: Card,
  action: 'add' | 'edit' | 'check',
): Promise<boolean> {
  const content = serializeCard(card);

  if (deps.store.kind !== 'none') {
    const file = cardPath(deps.corpusPath, card.id);
    const before = action === 'add' || !fs.existsSync(file) ? null : fs.readFileSync(file);
    try {
      await deps.store.put(cardObjectName(card.id), content, {
        blob: blobHash(content),
        base: before ? blobHash(before) : NO_BASE,
        ifGenerationMatch: action === 'add' ? 0 : undefined,
      });
    } catch (err) {
      deps.logger.error(`遠端寫入失敗 ${card.id}: ${errText(err)}`);
      return false;
    }
  }

  writeCardContent(deps.corpusPath, card.id, content);
  try {
    deps.index.putCard(card);
  } catch (err) {
    deps.logger.error(`索引寫入失敗 ${card.id}: ${errText(err)}`);
  }
  deps.git.commitCard(card.id, action);
  return true;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 索引裡的 type 是 TEXT——它是投影，必須容得下壞資料，所以型別刻意鬆散。
 * 規則那一層要的是收窄過的 CardType，收窄只在這裡做一次。
 */
function cardTypeOf(deps: CardServiceDeps, id: string): CardType | null {
  const t = deps.index.typeOf(id);
  return isCardType(t) ? t : null;
}
