/** 卡片的三種類型、連結詞彙表、來源標記。 */

export const CARD_TYPES = ['original', 'restatement', 'thinking'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** 從一張卡開新卡時可選的類型。一手材料不會是誰的回應。 */
export const REPLY_TYPES = ['restatement', 'thinking'] as const;

/** 連結關係，封閉集合，不接受其他值。 */
export const REL_TYPES = [
  'about',
  'related',
  'supports',
  'contradicts',
  'refutes',
  'updates',
] as const;
export type Rel = (typeof REL_TYPES)[number];

/** 從一張卡開新卡時，連結預設的關係。 */
export const DEFAULT_REL: Rel = 'related';

/** 只有 original 類型可填。 */
export const PROVENANCES = ['default', 'translated', 'AI-summarized'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export interface CardLink {
  rel: Rel;
  to: string;
}

/** 一張卡片的 frontmatter。欄位順序即寫入檔案的順序。 */
export interface CardMeta {
  id: string;
  type: CardType;
  created: string;
  title: string;
  tags: string[];
  url: string | null;
  provenance: string | null;
  revised: string | null;
  links: CardLink[];
}

export interface Card extends CardMeta {
  body: string;
}

/** 使用者送進來、還沒有 ID 的東西。 */
export interface CardDraft {
  type: string;
  title: string;
  body: string;
  tags: string[];
  url: string | null;
  provenance: string | null;
  links: { rel: string; to: string }[];
}

export function isCardType(v: unknown): v is CardType {
  return typeof v === 'string' && (CARD_TYPES as readonly string[]).includes(v);
}

export function isRel(v: unknown): v is Rel {
  return typeof v === 'string' && (REL_TYPES as readonly string[]).includes(v);
}

export function isProvenance(v: unknown): v is Provenance {
  return typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v);
}
