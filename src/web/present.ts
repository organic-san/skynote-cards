import type { ThreadNode } from '../store/index/index.ts';
import type { ListRow } from '../service/lists.ts';
import {
  CARD_ACTIONS,
  REL_LABELS,
  REL_LABELS_BACK,
  REL_MATRIX,
  TYPE_LABELS,
  type CardType,
  type Rel,
} from '../domain/types.ts';

/**
 * 資料列 → view model。
 *
 * 模板只會拿到已經格式化好的字串與旗標，不會拿到資料列；
 * 「這一列在畫面上長什麼樣子」的判斷全部集中在這裡。
 */

/**
 * 列表上的一項。
 *
 * 模板只會拿到這四個可為 null 的欄位，然後有什麼畫什麼——它不知道
 * 有幾種型別，也不知道哪一型該顯示什麼。所有 per-type 的差異都在
 * 下面那張表裡。
 */
export interface Item {
  id: string;
  type: string;
  typeLabel: string;
  title: string;
  date: string;
  /** 內文開頭。null 代表這一型不顯示內文。 */
  excerpt: string | null;
  /** 標題**之上**的一行：目前只有 original 用，放它的出處。 */
  eyebrow: string | null;
  /** 標題**之下**的一行：目前只有 restatement 用，放它在講哪一份。 */
  meta: string | null;
  /** 數量摘要。只在真的有東西可數時出現。 */
  counts: string | null;
  tags: string[];
}

/**
 * 這一型的列表項長什麼形狀。
 *
 * 四型原本只差一顆型別籤，形狀完全一樣——差別全壓在那顆籤上，
 * 掃過去就是一片同樣的東西。現在讓形狀自己說話：
 * `original` 把出處放到標題之上、`restatement` 在底下指出它在講哪一份、
 * `thinking` 只有標題與內文、`fleeting` 根本不長得像一張卡。
 * 型別籤留著，但改由顏色承接辨識（見 style.css 的 .rtype-*）。
 */
type Shape = (row: ListRow) => Pick<Item, 'excerpt' | 'eyebrow' | 'meta' | 'counts'>;

const ITEM_SHAPES: Record<CardType, Shape> = {
  /**
   * 出處放在標題**之上**：這張卡最要緊的事實是「它從哪裡來」，
   * 不是它自己說了什麼。不顯示內文開頭。
   * 作者與年份缺一就退回網址的網域，再缺就是「未署名」——
   * 這一行永遠在，因為「這份材料沒有署名」本身就是關於它的事實。
   */
  original: (row) => ({
    excerpt: null,
    eyebrow: sourceLine(row.source_author, row.source_date, row.url),
    meta: null,
    counts: row.restatements > 0 ? `${row.restatements} 則重述` : null,
  }),
  /** 標題與內文是我寫的，底下指出它在對照哪一份原始資料。 */
  restatement: (row) => ({
    excerpt: excerpt(row.body),
    eyebrow: null,
    meta: row.about ? row.about.title : null,
    counts: null,
  }),
  /** 只有標題與內文。連結數在列表上不驅動任何決定，拿掉了。 */
  thinking: (row) => ({
    excerpt: excerpt(row.body),
    eyebrow: null,
    meta: null,
    counts: null,
  }),
  /** 整句話就是它的全部內容。它不是一張卡，是一行字。 */
  fleeting: () => ({ excerpt: null, eyebrow: null, meta: null, counts: null }),
};

export function toItem(row: ListRow): Item {
  const shape = ITEM_SHAPES[row.type as CardType] ?? ITEM_SHAPES.thinking;
  return {
    id: row.id,
    type: row.type,
    typeLabel: TYPE_LABELS[row.type as CardType] ?? row.type,
    title: row.title,
    date: fmtDate(row.created),
    tags: row.tags,
    ...shape(row),
  };
}

/**
 * 關係在畫面上的說法。
 * `out` 是本卡指向那一張，`in` 是那一張指向本卡——同一條連結，兩種讀法。
 */
export function relLabel(rel: string, direction: 'in' | 'out' = 'out'): string {
  const table = direction === 'in' ? REL_LABELS_BACK : REL_LABELS;
  return table[rel as Rel] ?? rel;
}

/**
 * 一份原始資料的出處，一行。
 *
 * 「Herbert A. Simon · 1962」→「Herbert A. Simon」→「example.com」→「未署名」。
 * 逐級退，但永遠有一行——隨手貼進來的文章通常沒有作者與年份，
 * 而那正是最需要一眼看出「這是外面的東西」的時候。
 */
function sourceLine(
  author: string | null,
  date: string | null,
  url: string | null,
): string {
  const parts = [author, date].filter((x): x is string => !!x && x.trim() !== '');
  if (parts.length > 0) return parts.join(' · ');
  const host = hostOf(url);
  return host ?? '未署名';
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 引用串的節點。
 *
 * 同一條連結從兩端看是兩件事，所以關係名分兩套（見 REL_LABELS）：
 * - `out`（上游，本卡指向的目標）→「節錄自 ⟨那張卡⟩」
 * - `in`（下游，指向本卡的來源）→「節錄出 ⟨那張卡⟩」
 *
 * 兩邊用同一個詞會把關係講反，所以方向不能只由呼叫端知道。
 */
export function decorateThread(
  nodes: ThreadNode[],
  openDepth: number,
  direction: 'in' | 'out',
): Record<string, unknown>[] {
  const walk = (n: ThreadNode): Record<string, unknown> => ({
    id: n.id,
    rel: n.rel,
    relLabel: relLabel(n.rel, direction),
    type: n.type,
    typeLabel: n.type === null ? '' : (TYPE_LABELS[n.type as CardType] ?? n.type),
    title: n.title,
    missing: n.title === null,
    repeated: n.repeated,
    date: fmtDate(n.created),
    open: n.depth < openDepth,
    children: n.children.map(walk),
  });
  return nodes.map(walk);
}

// ---------------------------------------------------------------- 格式化

/** UTC 時間，精簡到分。系統只有一個使用者，不做時區轉換。 */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString().slice(0, 10);
}

/**
 * 內文開頭的一小段，給列表與引用串用。
 * 只剝掉會在單行裡變成雜訊的 markdown 記號，不做完整解析。
 */
export function excerpt(body: string | null, max = 90): string {
  if (!body) return '';
  const flat = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[#>\-*+]+\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------- 建立表單

/**
 * 這一型的表單長什麼樣子。
 *
 * 模板拿到的是幾個布林值，不是型別名——「original 才顯示 url」這種判斷
 * 只在這張表裡出現一次，不散進 .eta 與前端腳本各寫一遍。
 */
export interface FormSpec {
  /** 只有一個大文字框，不區分標題與內文（A.5 的欄位反轉）。 */
  single: boolean;
  /** url 對 original 是主要欄位，從收合區移出來。其他型別關閉。 */
  url: boolean;
  /** provenance 與 source_author / source_date，original 專屬。 */
  source: boolean;
  /** 能不能加連結。碎片不行（R2）。 */
  links: boolean;
}

const FORM_SPECS: Record<CardType, FormSpec> = {
  original: { single: false, url: true, source: true, links: true },
  restatement: { single: false, url: false, source: false, links: true },
  thinking: { single: false, url: false, source: false, links: true },
  fleeting: { single: true, url: false, source: false, links: false },
};

/**
 * 還沒選型別時什麼都不開，包括連結。
 *
 * rel 的合法組合是由「新卡的型別」決定的，型別還沒定，就沒有任何一條 rel
 * 列得出來——這時候給一個空的下拉選單，比不給更糟：它看起來就是壞的。
 */
export function formSpec(type: string): FormSpec {
  return FORM_SPECS[type as CardType] ?? { single: false, url: false, source: false, links: false };
}

/** 整張表送給前端，讓它換型別時不必自己知道規則。 */
export const FORM_SPEC_TABLE = FORM_SPECS;

/**
 * 這張卡的詳細頁上，`+` 選單裡有哪幾顆按鈕。
 * 每一顆都把新卡的型別與那條連結填好，帶著回來這張卡的 ID。
 */
export function actionsFor(type: string, id: string) {
  const actions = CARD_ACTIONS[type as CardType] ?? [];
  return actions.map((a) => ({
    label: a.label,
    href: `/new?type=${a.creates}&rel=${encodeURIComponent(a.rel)}&to=${id}`,
    rel: a.rel,
  }));
}

export interface RelOption {
  value: string;
  /** 介面上的名字。跟引用串用同一組，畫面上不再出現內部 rel 名。 */
  label: string;
  /** 允許的目標型別。**只拿來過濾，不顯示**——你選目標的時候已經在看它了，
   *  「我可以指向誰」是回頭才有用的資訊。 */
  targets: string[];
}

/**
 * 表單裡的 rel 下拉。
 *
 * 依「新卡的型別」收窄；目標已知時再依目標的型別收窄一次。
 * 列不出來的組合按下去只會被規則擋掉，而被擋的當下看不出為什麼——
 * 所以乾脆不列。這是 R3 硬擋能不刺人的前提。
 */
export function relOptions(type: string, targetType?: string | null): RelOption[] {
  const specs = REL_MATRIX[type as CardType] ?? [];
  return specs
    .filter((s) => !targetType || (s.targets as readonly string[]).includes(targetType))
    .map((s) => ({
      value: s.rel,
      label: REL_LABELS[s.rel],
      targets: [...s.targets],
    }));
}
