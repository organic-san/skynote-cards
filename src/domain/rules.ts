import type { Card, CardDraft, CardLink, CardType, Provenance, Rel } from './types.ts';
import { TYPE_LABELS, allowedTargets, isCardType, isProvenance, isRel } from './types.ts';
import { compareIds, isValidIdFormat } from './id.ts';

/** 建立卡片的驗證。依序執行，任何一項失敗整筆拒絕，不做部分寫入。 */

export interface ValidationResult {
  errors: string[];
  /** 正規化後的內容。errors 非空時為 undefined。 */
  value?: {
    type: CardType;
    title: string;
    tags: string[];
    url: string | null;
    provenance: Provenance | null;
    source_author: string | null;
    source_date: string | null;
    links: CardLink[];
  };
}

export interface ValidateDeps {
  /** 目標卡片檔案是否存在。 */
  cardExists: (id: string) => boolean;
  /** 目標卡片的型別，不存在或型別不合法時 null。R1 與 R3 需要。 */
  typeOf: (id: string) => CardType | null;
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * 型別、標題、標籤、連結詞彙、目標存在、連結不重複、provenance 限制。
 * 連結的順序規則需要本卡 ID，而 ID 在驗證通過後才產生，
 * 所以那一條拆到 validateLinkOrder。兩段都通過才會寫檔。
 */
export function validateDraft(draft: CardDraft, deps: ValidateDeps): ValidationResult {
  const errors: string[] = [];

  // 型別
  if (!isCardType(draft.type)) {
    errors.push('未選類型');
  }

  // 標題
  const title = (draft.title ?? '').trim();
  if (title === '') errors.push('標題不得為空');

  // 標籤：每一項 trim 後非空，去重
  const tags: string[] = [];
  for (const raw of draft.tags ?? []) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (t === '') {
      errors.push('標籤不得為空');
      continue;
    }
    // 不做任何正規化（不轉小寫、不合併相似項），只去除完全相同的重複。
    if (!tags.includes(t)) tags.push(t);
  }

  // R2 先擋：碎片帶了連結，問題就是「它不該有連結」，
  // 不是那幾條連結各自哪裡不對。逐條報反而蓋住真正的訊息。
  const noLinksAllowed = isCardType(draft.type)
    ? checkFleetingHasNoLinks(draft.type, (draft.links ?? []).length)
    : [];
  errors.push(...noLinksAllowed);

  // 連結：rel 在詞彙表內、目標存在、同 rel 同目標不得重複
  const linksBefore = errors.length;
  const checked = checkLinks(draft.links ?? [], deps);
  const links = checked.links;
  errors.push(...checked.errors);

  // provenance 是 original 專屬的欄位。其他類型送了什麼都不寫進卡片，
  // 也不當成錯誤——表單上這個欄位是關著的，送上來的值只是它自己的殘留。
  //
  // 「非 original 帶 provenance 就整筆退回」的決定被推翻，因為那個欄位
  // 在表單上一直存在、一直有值，使用者根本沒有辦法「不填」它。
  const provenanceRaw = emptyToNull(draft.provenance);
  let provenance: Provenance | null = null;
  if (draft.type === 'original') {
    if (provenanceRaw === null) {
      provenance = 'default'; // 未指定時的預設值
    } else if (!isProvenance(provenanceRaw)) {
      errors.push('provenance 不合法');
    } else {
      provenance = provenanceRaw;
    }
  }

  // R1 與 R3 要問目標的型別，所以只在每一條連結本身都成立之後才跑——
  // 否則一條「目標不存在」會同時觸發「重述沒有原文可對照」，報兩次同一件事。
  if (isCardType(draft.type) && errors.length === linksBefore && noLinksAllowed.length === 0) {
    errors.push(...checkRestatementHasSource(draft.type, links, deps.typeOf));
    errors.push(...checkRelMatrix(draft.type, links, deps.typeOf));
  }

  // source_author / source_date 與 provenance 同一條理由：它們是 original
  // 專屬的欄位，其他型別送了什麼都不寫進卡片，也不當成錯誤。
  const isOriginal = draft.type === 'original';

  if (errors.length > 0) return { errors };

  return {
    errors,
    value: {
      type: draft.type as CardType,
      title,
      tags,
      url: emptyToNull(draft.url),
      provenance,
      source_author: isOriginal ? emptyToNull(draft.source_author) : null,
      source_date: isOriginal ? emptyToNull(draft.source_date) : null,
      links,
    },
  };
}

/**
 * 每一條連結自己的體檢：rel 在詞彙表內、ID 格式對、目標存在、彼此不重複。
 *
 * 這一段先前寫在 validateDraft 裡面。抽出來是因為 R7 也要用它——反芻期內
 * 新增的連結必須通過當下的現行規則，而那是「同一組檢查」而不是「像那組的檢查」。
 * 留在裡面的話，第二個呼叫端只能複製一份，然後兩份會慢慢長歪。
 *
 * `already` 是已經存在的連結，用來擋「跟既有的重複」——建立時是空的，
 * 反芻期新增時是這張卡現有的那幾條。
 */
export function checkLinks(
  raw: { rel?: string; to?: string }[],
  deps: Pick<ValidateDeps, 'cardExists'>,
  already: CardLink[] = [],
): { links: CardLink[]; errors: string[] } {
  const errors: string[] = [];
  const links: CardLink[] = [];
  const seen = new Set(already.map((l) => `${l.rel} ${l.to}`));

  for (const [i, item] of raw.entries()) {
    const rel = item?.rel;
    const to = typeof item?.to === 'string' ? item.to.trim() : '';

    if (!isRel(rel)) {
      errors.push(`第 ${i + 1} 條連結：關係不在詞彙表內`);
      continue;
    }
    if (!isValidIdFormat(to)) {
      errors.push(`第 ${i + 1} 條連結：ID 格式錯誤`);
      continue;
    }
    if (!deps.cardExists(to)) {
      errors.push(`第 ${i + 1} 條連結：目標不存在`);
      continue;
    }
    const key = `${rel} ${to}`;
    if (seen.has(key)) {
      errors.push(`第 ${i + 1} 條連結：與前面重複`);
      continue;
    }
    seen.add(key);
    links.push({ rel: rel as Rel, to });
  }

  return { links, errors };
}

// ---------------------------------------------------------------- 型別對連結的約束

/**
 * R1：restatement 必須至少有一條 about 指向 original。
 *
 * 沒有原文可對照的東西不是重述。這條直接消除「參照對象是世界的
 * restatement」——那種卡片依定義是 thinking 或 fleeting。
 */
export function checkRestatementHasSource(
  type: CardType,
  links: CardLink[],
  typeOf: (id: string) => CardType | null,
): string[] {
  if (type !== 'restatement') return [];
  const grounded = links.some((l) => l.rel === 'about' && typeOf(l.to) === 'original');
  return grounded ? [] : ['重述必須有一條 about 指向原始資料'];
}

/**
 * R2：fleeting 不得有任何連結。
 *
 * 一旦開始建立關聯，做的就是 thinking 的工作。這條讓碎片的建立成本
 * 真正降到「一個欄位」。
 */
export function checkFleetingHasNoLinks(type: CardType, linkCount: number): string[] {
  if (type !== 'fleeting' || linkCount === 0) return [];
  return ['碎片不能有連結'];
}

/**
 * R3：每一型只能使用自己被允許的 rel，且目標型別必須符合矩陣。
 *
 * 硬性規則，不是警告：有方向的規則可以之後放寬，沒有約束的欄位只會發散。
 * 放寬對既有資料是免費的——規則不追溯（R4）。
 */
export function checkRelMatrix(
  type: CardType,
  links: CardLink[],
  typeOf: (id: string) => CardType | null,
): string[] {
  const errors: string[] = [];
  for (const [i, l] of links.entries()) {
    const targets = allowedTargets(type, l.rel);
    if (targets === null) {
      errors.push(`第 ${i + 1} 條連結：${TYPE_LABELS[type]}不能用 ${l.rel}`);
      continue;
    }
    const targetType = typeOf(l.to);
    // 目標不存在時不在這裡報：那是「目標不存在」的責任，別報兩次。
    if (targetType === null) continue;
    if (!targets.includes(targetType)) {
      errors.push(
        `第 ${i + 1} 條連結：${TYPE_LABELS[type]}不能用 ${l.rel} 指向${TYPE_LABELS[targetType]}`,
      );
    }
  }
  return errors;
}

/**
 * 連結只能指向 ID 較小、也就是更早建立的卡片。
 * 這保證整張圖是 DAG，也保證新增連結永遠只需要寫新檔案。
 */
export function validateLinkOrder(sourceId: string, links: CardLink[]): string[] {
  const errors: string[] = [];
  for (const [i, l] of links.entries()) {
    if (compareIds(l.to, sourceId) >= 0) {
      errors.push(`第 ${i + 1} 條連結：目標比這張卡新`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 已撤回

// W1 警告（推翻或改寫了別的卡卻沒附依據）的決定被推翻，因為 updates 的語義
// 在 v2 已經改變——它現在是「換一個更好的版本」與「把碎片完整化」，
// 不再是「推翻」，而 refutes 的目標也被矩陣收窄到 thinking / fleeting，
// 原本那句「推翻一張原始資料卡」的舉例已經不可能發生。剩下的只有摩擦。

// ---------------------------------------------------------------- 反芻期

/**
 * 反芻期的預設長度，小時（R5）。
 *
 * 不是五分鐘：五分鐘只夠對齊字句。思維本來就會迭代，一個衝動記下的東西需要
 * 一段窗口去補完還沒迭代完的內容——那段時間要用來想「哪些才是真正該被記錄的」。
 * 8 小時跨得過一個工作段落與一次睡眠。
 *
 * 這是行為參數，靠使用經驗調整，所以真正生效的值來自 config 的
 * EDIT_WINDOW_HOURS；這裡只放沒有設定時的預設。它只改變「還能不能改」，
 * 永遠不會回頭改寫已經寫好的東西。
 */
export const DEFAULT_EDIT_WINDOW_HOURS = 8;

export const LOCKED_MESSAGE = '這張卡已鎖定。要更正內容請建立新卡片並使用 updates 連結。';

/** 刪除被擋下來時說的話。跟編輯分開，因為那句話講的是「改用 updates」。 */
export const UNDELETABLE_MESSAGE = '這張卡已定案，不能刪除。';

/**
 * 一張卡的反芻狀態。
 *
 * 「還能不能改」「還能不能刪」「meta 行要寫什麼」先前是三個各自判斷的問題
 * （canEdit / isWithinEditWindow / lockAt 三個重疊的述詞），而它們的答案其實
 * 是同一件事。R6 把它講明白了——**有人開始依賴你，你就定案了**：一個判準
 * 同時管住從待辦清單移出、關閉編輯、禁止刪除。所以這裡只回答一次。
 *
 * `reason` 分兩種不是為了好看：時間到與被指向在畫面上要說不同的話
 * （D.5：已被指向而提前定案的顯示定案狀態，而不是一個已經沒有意義的倒數）。
 */
export type Rumination =
  | { open: true; until: string }
  | { open: false; reason: 'cited' | 'expired' };

/**
 * 純函式：兩個事實進來，狀態出去。
 *
 * 「有沒有人指向這張卡」是索引才知道的事，而這一層不能碰索引，所以它是
 * 參數而不是查詢——跟 validateDraft 收 { cardExists, typeOf } 是同一個做法。
 * 去問索引的那一步在 service/cards.ts 的 ruminationFor。
 */
export function ruminationOf(
  card: Pick<Card, 'created'>,
  ctx: { windowMs: number; cited: boolean; now?: number },
): Rumination {
  // R6 先判：被指向就立刻定案，不論反芻期是否結束。
  if (ctx.cited) return { open: false, reason: 'cited' };

  const created = Date.parse(card.created);
  if (Number.isNaN(created)) return { open: false, reason: 'expired' };

  const until = created + ctx.windowMs;
  // 窗口長度算不出來（設定壞了）就當成關的。開著的分支要產生一個 ISO 字串，
  // 而 new Date(NaN).toISOString() 會丟例外——那會把設定的手誤變成一整頁 500。
  // 往「關」的方向倒也比較安全：它不會讓任何本來不該發生的修改發生。
  if (!Number.isFinite(until)) return { open: false, reason: 'expired' };
  if ((ctx.now ?? Date.now()) > until) return { open: false, reason: 'expired' };
  return { open: true, until: new Date(until).toISOString() };
}

/**
 * 還在反芻期內的卡片，最早是什麼時候建立的。
 * 「沉澱」清單用一句 SQL 撈這一批，所以界線要先算成 ISO 字串。
 * R6 的另一半（被指向就出清單）由那句 SQL 自己的條件負責，見 query.ts。
 */
export function editableSince(windowMs: number, now = Date.now()): string {
  return new Date(now - windowMs).toISOString();
}

// ---------------------------------------------------------------- 已撤回

// EDIT_WINDOW_MS（寫死的五分鐘）的決定被推翻，因為 R5 把窗口改成行為參數：
// 長度要靠使用經驗調整，寫死在程式碼裡就調不動。現在來自 config。

// canEdit / isWithinEditWindow / lockAt 三個述詞被 ruminationOf 取代，因為
// R6 之後它們回答的是同一個問題的三個切面，而三個各自判斷就會有三種答案。
// canEdit 當初是為這個 phase 預留的接縫，但它從來沒有被呼叫過——
// 路由與寫入路徑一直直接問 isWithinEditWindow，接縫是死的。
