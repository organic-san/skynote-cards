import type { CardIndex, CardRow, CardRowWithTags } from '../store/index/index.ts';
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

// 側欄每一項後面的數字被 U9 推翻——那些清單實務上不會歸零，
// 數字提供不了「還剩多少」的訊號。連帶把每個請求的四次 COUNT(*) 省掉，
// 那個成本本來會隨卡片數線性成長。

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
}

export function decorate(index: CardIndex, rows: CardRowWithTags[]): ListRow[] {
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

export function tagCounts(index: CardIndex): { tag: string; n: number }[] {
  return index.tagCounts();
}

/** 空字串不查，避免把整個語料庫掃一遍換回一份空清單。 */
export function search(index: CardIndex, q: string, limit = 100): CardRowWithTags[] {
  return q === '' ? [] : index.search(q, limit);
}

/** 建立表單的連結選擇器。 */
export function picker(index: CardIndex, q: string, limit: number): CardRow[] {
  return index.pickerSearch(q, limit);
}
