import type { Card, CardDraft, CardLink, CardType, Provenance, Rel } from './types.ts';
import { isCardType, isProvenance, isRel } from './types.ts';
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
    links: CardLink[];
  };
}

export interface ValidateDeps {
  /** 目標卡片檔案是否存在。 */
  cardExists: (id: string) => boolean;
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

  // 連結：rel 在詞彙表內、目標存在、同 rel 同目標不得重複
  const links: CardLink[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of (draft.links ?? []).entries()) {
    const rel = raw?.rel;
    const to = typeof raw?.to === 'string' ? raw.to.trim() : '';

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

  if (errors.length > 0) return { errors };

  return {
    errors,
    value: {
      type: draft.type as CardType,
      title,
      tags,
      url: emptyToNull(draft.url),
      provenance,
      links,
    },
  };
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

// ---------------------------------------------------------------- 警告

export const W1_MESSAGE = '推翻或改寫了別的卡，但沒有附依據';

const OVERTURN_RELS: Rel[] = ['refutes', 'updates'];

/**
 * 推翻或取代了別的卡，卻沒有附上依據時發出的警告。
 * 判定依據時排除 refutes/updates 連結本身，
 * 否則「推翻一張原始資料卡」會自己滿足自己的舉證要求。
 */
export function computeW1(links: CardLink[], typeOf: (id: string) => string | null): boolean {
  const overturns = links.some((l) => OVERTURN_RELS.includes(l.rel));
  if (!overturns) return false;
  const hasEvidence = links.some((l) => {
    if (OVERTURN_RELS.includes(l.rel)) return false;
    const t = typeOf(l.to);
    return t === 'original' || t === 'restatement';
  });
  return !hasEvidence;
}

// ---------------------------------------------------------------- 編輯時窗

export const EDIT_WINDOW_MS = 5 * 60 * 1000;

export const LOCKED_MESSAGE = '這張卡已鎖定。要更正內容請建立新卡片並使用 updates 連結。';

export function isWithinEditWindow(card: Pick<Card, 'created'>, now = Date.now()): boolean {
  const created = Date.parse(card.created);
  if (Number.isNaN(created)) return false;
  return now - created <= EDIT_WINDOW_MS;
}
