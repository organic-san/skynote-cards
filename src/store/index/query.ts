import { type IndexDb, ftsQuery, idDesc } from './schema.ts';

/** 索引的讀取面。每一支都是純查詢，不寫入任何東西。 */

export interface CardRow {
  id: string;
  type: string;
  created: string;
  title: string;
  url: string | null;
  provenance: string | null;
  revised: string | null;
  body: string;
  link_count: number;
  tag_count: number;
}

export interface CardRowWithTags extends CardRow {
  tags: string[];
}

export interface LinkRow {
  rel: string;
  id: string;
  title: string | null;
  type: string | null;
  created: string | null;
  body: string | null;
}

export interface ThreadNode extends LinkRow {
  depth: number;
  /** 這個節點在別的分支已經展開過，這裡只留一行。 */
  repeated: boolean;
  children: ThreadNode[];
}

export function countCards(idx: IndexDb): number {
  return (idx.s('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
}

export function getCard(idx: IndexDb, id: string): CardRowWithTags | null {
  const row = idx.s('SELECT * FROM cards WHERE id = ?').get(id) as
    | CardRow
    | undefined;
  if (!row) return null;
  return { ...row, tags: tagsOf(idx, id) };
}

export function tagsOf(idx: IndexDb, id: string): string[] {
  return (
    idx.s('SELECT tag FROM tags WHERE card_id = ? ORDER BY rowid').all(id) as {
      tag: string;
    }[]
  ).map((r) => r.tag);
}

export function typeOf(idx: IndexDb, id: string): string | null {
  const row = idx.s('SELECT type FROM cards WHERE id = ?').get(id) as
    | { type: string }
    | undefined;
  return row?.type ?? null;
}

export function listCards(
  idx: IndexDb,
  opts: { type?: string; tag?: string; limit: number; offset: number },
): {
  rows: CardRowWithTags[];
  total: number;
} {
  const where: string[] = [];
  const params: unknown[] = [];
  let from = 'FROM cards c';
  if (opts.tag) {
    from += ' JOIN tags t ON t.card_id = c.id AND t.tag = ?';
    params.push(opts.tag);
  }
  if (opts.type) {
    where.push('c.type = ?');
    params.push(opts.type);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = (
    idx.s(`SELECT COUNT(*) AS n ${from}${whereSql}`).get(...params) as { n: number }
  ).n;

  const rows = idx.s(
      `SELECT c.* ${from}${whereSql} ORDER BY c.created DESC, ${idDesc('c.id')} LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as CardRow[];

  return { rows: rows.map((r) => ({ ...r, tags: tagsOf(idx, r.id) })), total };
}

/** 出向連結：這張卡指向誰。target 不存在時 title 為 null。 */
export function outLinks(idx: IndexDb, id: string): LinkRow[] {
  return idx.s(
      `SELECT l.rel AS rel, l.target_id AS id,
              c.title AS title, c.type AS type, c.created AS created, c.body AS body
         FROM links l LEFT JOIN cards c ON c.id = l.target_id
        WHERE l.source_id = ?
        ORDER BY ${idDesc('l.target_id')}`,
    )
    .all(id) as LinkRow[];
}

/**
 * 反向連結：誰指向這張卡。
 * 連結一律指向更早的卡片，沒有這個查詢，一張卡對
 * 「誰用了我、誰推翻了我」完全無知。
 */
export function backLinks(idx: IndexDb, id: string): LinkRow[] {
  return idx.s(
      `SELECT l.rel AS rel, l.source_id AS id,
              c.title AS title, c.type AS type, c.created AS created, c.body AS body
         FROM links l JOIN cards c ON c.id = l.source_id
        WHERE l.target_id = ?
        ORDER BY ${idDesc('l.source_id')}`,
    )
    .all(id) as LinkRow[];
}

/**
 * 把連結展開成一棵可以逐層縮排顯示的樹。
 *
 * 'in' 是誰引用了這張卡，'out' 是這張卡引用了誰。
 * 連結只能指向更早的卡片，所以往任一方向走 ID 都嚴格單調，不可能繞回來。
 * 這是一張 DAG 不是樹：同一張卡會從不同分支被走到，
 * 只有第一次完整展開，之後標成 repeated 且不再往下。
 */
export function linkTree(
  idx: IndexDb,
  rootId: string,
  direction: 'in' | 'out',
  maxDepth: number,
): ThreadNode[] {
  const seen = new Set<string>([rootId]);
  const expand = (id: string, depth: number): ThreadNode[] => {
    const rows = direction === 'in' ? backLinks(idx, id) : outLinks(idx, id);
    return rows.map((r) => {
      const missing = r.title === null;
      const repeated = seen.has(r.id);
      if (!repeated && !missing) seen.add(r.id);
      return {
        id: r.id,
        rel: r.rel,
        title: r.title,
        type: r.type,
        created: r.created,
        body: r.body,
        depth,
        repeated,
        children:
          repeated || missing || depth + 1 >= maxDepth ? [] : expand(r.id, depth + 1),
      };
    });
  };
  return expand(rootId, 0);
}

/** 出向連結的目標型別，判斷 W1 警告用。 */
export function linkTargetTypes(idx: IndexDb, id: string): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const l of outLinks(idx, id)) m.set(l.id, l.type);
  return m;
}

export function tagCounts(idx: IndexDb): { tag: string; n: number }[] {
  return idx.s('SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag ASC')
    .all() as { tag: string; n: number }[];
}

/** type = 'thinking' 且沒有任何連結的卡片：目前所有沒有依據的信念。 */
export function orphans(idx: IndexDb): CardRowWithTags[] {
  const rows = idx.s(
      `SELECT * FROM cards WHERE type = 'thinking' AND link_count = 0
        ORDER BY created DESC, ${idDesc('id')}`,
    )
    .all() as CardRow[];
  return rows.map((r) => ({ ...r, tags: tagsOf(idx, r.id) }));
}

export function search(idx: IndexDb, q: string, limit = 50): CardRowWithTags[] {
  const match = ftsQuery(q);
  if (!match) return [];
  let rows: CardRow[];
  try {
    rows = idx.s(
        `SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.id
          WHERE cards_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as CardRow[];
  } catch {
    return [];
  }
  return rows.map((r) => ({ ...r, tags: tagsOf(idx, r.id) }));
}

/**
 * 建立表單的連結選擇器：同時支援貼上 ID 與打字搜尋標題。
 * 走 ID 精確比對加標題子字串比對，不走全文檢索——
 * unicode61 不切中文詞，對標題這種短字串 LIKE 反而準。
 */
export function pickerSearch(idx: IndexDb, q: string, limit = 10): CardRow[] {
  const term = q.trim();
  if (term === '') return [];
  const like = `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  return idx.s(
      `SELECT * FROM cards
        WHERE id = ? OR title LIKE ? ESCAPE '\\'
        ORDER BY (id = ?) DESC, created DESC, ${idDesc('id')}
        LIMIT ?`,
    )
    .all(term, like, term, limit) as CardRow[];
}
