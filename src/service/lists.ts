import type {
  CardIndex,
  CardRow,
  CardRowWithTags,
  SearchRow,
  TagCount,
  TagSort,
} from '../store/index/index.ts';
import { editableSince } from '../domain/rules.ts';

/**
 * 各種清單。每一份清單問的是一個問題，問題本身寫在這裡，
 * 路由只負責把答案交給模板。
 */

export const PAGE_SIZE = 50;

/** 側欄裡最近幾張卡片。 */
export const RECENT_LIMIT = 20;

export interface FeedResult {
  rows: CardRowWithTags[];
  total: number;
  pages: number;
}

/** 時間逆序的卡片流，可依 type / tag 篩選。 */
export function feed(
  index: CardIndex,
  opts: { type?: string; tag?: string; page: number },
): FeedResult {
  const { rows, total } = index.listCards({
    type: opts.type,
    tag: opts.tag,
    limit: PAGE_SIZE,
    offset: (opts.page - 1) * PAGE_SIZE,
  });
  return { rows, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** 每一頁的側欄都帶著這一份。 */
export function recent(index: CardIndex): CardRowWithTags[] {
  return index.listCards({ limit: RECENT_LIMIT, offset: 0 }).rows;
}

// ---------------------------------------------------------------- 工作狀態清單

// 側欄工作狀態清單（U9：不帶數量標籤）。

/** 待思考：收進來但沒有人接手的原始資料。 */
export function pending(index: CardIndex): CardRowWithTags[] {
  return index.pending();
}

/** 初步想法：兩頭都懸空的思考。 */
export function looseThinking(index: CardIndex): CardRowWithTags[] {
  return index.looseThinking();
}

/** 碎片：沒有被撿起來用過的隨手記。 */
export function looseFleeting(index: CardIndex): CardRowWithTags[] {
  return index.looseFleeting();
}

/**
 * 沉澱：還改得動的卡片。
 * 窗口長度是設定值，所以由呼叫端帶進來——這一層不讀 config。
 */
export function settling(index: CardIndex, editWindowMs: number): CardRowWithTags[] {
  return index.settling(editableSince(editWindowMs));
}

// ---------------------------------------------------------------- 列表項的補充資料

/**
 * A.6 要求每一型的列表項提供不同的東西，而那些東西不在 cards 這一列裡：
 * original 要「幾則重述 / 幾則引用」、restatement 要「它在講哪份原始資料」。
 *
 * 每一列多一兩次索引查詢。清單最多 50 列，而且都是走索引的點查；
 * 換成一句 JOIN 會讓四份清單的 SQL 各自長出一塊只有一型用得到的東西。
 */
export interface ListRow extends CardRowWithTags {
  inbound: number;
  restatements: number;
  about: { id: string; title: string } | null;
  /** 只有搜尋結果有：命中的那一小段。其餘清單維持 excerpt。 */
  frag?: string;
}

export function decorate(
  index: CardIndex,
  rows: (CardRowWithTags & { frag?: string })[],
): ListRow[] {
  return rows.map((r) => {
    if (r.type === 'original') {
      const b = index.inboundBreakdown(r.id);
      return { ...r, inbound: b.total, restatements: b.restatements, about: null };
    }
    if (r.type === 'restatement') {
      return { ...r, inbound: 0, restatements: 0, about: index.aboutTarget(r.id) };
    }
    if (r.type === 'thinking') {
      return {
        ...r,
        inbound: index.inboundBreakdown(r.id).total,
        restatements: 0,
        about: null,
      };
    }
    return { ...r, inbound: 0, restatements: 0, about: null };
  });
}

/** 標籤與它的用量，外加「有沒有被鎖出推薦選單」。 */
export interface TagStat extends TagCount {
  locked: boolean;
}

/**
 * 標籤索引頁要的那一份：全部列出來，鎖定的也在，只是標成次要。
 *
 * 鎖定的標籤在這裡**不過濾掉**——那一頁問的是「語料庫裡有哪些標籤」，
 * 而 `匯入` 確實是其中一個。把它藏起來會讓「點進去看有哪些卡」這條路
 * 從介面上消失，而那正是出處標記最有用的時候。
 *
 * 鎖定清單由呼叫端帶進來（它在語料庫目錄裡，而這一層不讀 config，
 * 跟 settling 的 editWindowMs 同一條理由）。
 */
export function tagCounts(
  index: CardIndex,
  opts: { sort?: TagSort; locked?: ReadonlySet<string> } = {},
): TagStat[] {
  const locked = opts.locked;
  return index
    .tagCounts(opts.sort ?? 'count')
    .map((r) => ({ ...r, locked: locked ? locked.has(r.tag) : false }));
}

/**
 * 表單標籤欄的推薦選單。
 *
 * 跟索引頁是兩個不同的問題，所以是兩支函式而不是一個帶旗標的：
 * 這裡問的是「我現在打這張卡，可能想用哪個標籤」——按最近使用排序，
 * 因為主題是一陣一陣的；鎖定的整個不出現，因為出處標記永遠不是答案。
 *
 * 只交出 tag 與 n：選單上就這兩樣看得到的東西，其餘欄位跟著每一次
 * 表單渲染送到瀏覽器是白付的流量。
 */
export function tagSuggestions(
  index: CardIndex,
  locked: ReadonlySet<string>,
): { tag: string; n: number }[] {
  return tagCounts(index, { sort: 'recent', locked })
    .filter((t) => !t.locked)
    .map((t) => ({ tag: t.tag, n: t.n }));
}

/** 搜尋卡片內容（關鍵字為空時直接回傳空陣列）。 */
export function search(
  index: CardIndex,
  q: string,
  opts: { type?: string; limit?: number } = {},
): SearchRow[] {
  return q === '' ? [] : index.search(q, { limit: opts.limit ?? 100, type: opts.type });
}

/** 建立表單的連結選擇器。 */
export function picker(index: CardIndex, q: string, limit: number): CardRow[] {
  return index.pickerSearch(q, limit);
}
