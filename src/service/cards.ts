import type { Card, CardDraft, CardType } from '../domain/types.ts';
import { isCardType } from '../domain/types.ts';
import { fileExistsTaken, generateId } from '../domain/id.ts';
import {
  LOCKED_MESSAGE,
  isWithinEditWindow,
  validateDraft,
  validateLinkOrder,
} from '../domain/rules.ts';
import { cardExists, cardsDir, readCard, writeCardFile } from '../store/files.ts';
import type { CardIndex } from '../store/index/index.ts';
import type { GitBackup } from '../store/backup.ts';

/**
 * 建立與修改卡片。
 *
 * 這是唯一一個知道「一次寫入由哪幾件事構成」的地方：
 * 先落檔、再投影到索引、最後排一次備份。三者的順序與失敗的處理方式
 * 只在這裡定義一次，路由不重複一遍。
 */

export interface CardServiceDeps {
  corpusPath: string;
  index: CardIndex;
  git: GitBackup;
  logger: { error(msg: string): void };
}

export type CreateResult = { ok: true; card: Card } | { ok: false; errors: string[] };

/** 修改失敗分兩種：窗口已關（不可回復），與內容不合格（改了再送就行）。 */
export type UpdateResult =
  | { ok: true; card: Card }
  | { ok: false; reason: 'locked' | 'invalid'; errors: string[] };

/**
 * 表單送上來、還沒有 ID 的東西經過驗證之後落地。
 * 連結的順序規則需要本卡 ID，所以驗證分兩段，中間夾著發號。
 */
export function createCard(deps: CardServiceDeps, draft: CardDraft): CreateResult {
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

  persist(deps, card, 'add');
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
}

export function updateCard(
  deps: CardServiceDeps,
  id: string,
  patch: UpdatePatch,
): UpdateResult {
  const existing = readCard(deps.corpusPath, id);
  if (!isWithinEditWindow(existing)) {
    return { ok: false, reason: 'locked', errors: [LOCKED_MESSAGE] };
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

  const url = pickUrl(existing.url, patch.url);

  const updated: Card = {
    ...existing,
    title,
    tags,
    url,
    revised: new Date().toISOString(),
    body: (patch.body === undefined ? existing.body : patch.body).replace(/\r\n/g, '\n'),
  };

  persist(deps, updated, 'edit');
  return { ok: true, card: updated };
}

function pickUrl(current: string | null, given: string | undefined): string | null {
  if (given === undefined) return current;
  const v = given.trim();
  return v === '' ? null : v;
}

/**
 * 檔案是唯一真相，所以先寫檔。
 * 索引寫失敗不往上丟：檔案已經在了，索引隨時可以重建。
 * 備份是 fire-and-forget，不會擋住任何一條寫入路徑。
 */
function persist(deps: CardServiceDeps, card: Card, action: 'add' | 'edit'): void {
  writeCardFile(deps.corpusPath, card);
  try {
    deps.index.putCard(card);
  } catch (err) {
    deps.logger.error(
      `索引寫入失敗 ${card.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  deps.git.commitCard(card.id, action);
}

/**
 * 索引裡的 type 是 TEXT——它是投影，必須容得下壞資料，所以型別刻意鬆散。
 * 規則那一層要的是收窄過的 CardType，收窄只在這裡做一次。
 */
function cardTypeOf(deps: CardServiceDeps, id: string): CardType | null {
  const t = deps.index.typeOf(id);
  return isCardType(t) ? t : null;
}
