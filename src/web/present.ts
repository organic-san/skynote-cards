import type { CardRowWithTags, ThreadNode } from '../store/index/index.ts';

/**
 * 資料列 → view model。
 *
 * 模板只會拿到已經格式化好的字串與旗標，不會拿到資料列；
 * 「這一列在畫面上長什麼樣子」的判斷全部集中在這裡。
 */

export function toItem(row: CardRowWithTags) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    excerpt: excerpt(row.body),
    tags: row.tags,
    date: fmtDate(row.created),
  };
}

/** 引用串的節點。縮排線的顏色由 rel 決定，所以每個節點都帶著自己的 rel。 */
export function decorateThread(nodes: ThreadNode[], openDepth: number): Record<string, unknown>[] {
  const walk = (n: ThreadNode): Record<string, unknown> => ({
    id: n.id,
    rel: n.rel,
    type: n.type,
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
