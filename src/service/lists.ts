import type { CardIndex, CardRow, CardRowWithTags } from '../store/index/index.ts';

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

/** 目前所有沒有依據的信念。 */
export function orphans(index: CardIndex): CardRowWithTags[] {
  return index.orphans();
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
