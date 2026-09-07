import { type IndexDb, ftsQuery, idDesc } from './schema.ts';

/** 索引的讀取面。每一支都是純查詢，不寫入任何東西。 */

export interface CardRow {
  id: string;
  type: string;
  created: string;
  title: string;
  url: string | null;
  provenance: string | null;
  source_author: string | null;
  source_date: string | null;
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

export interface TagCount {
  tag: string;
  /** 用在幾張卡上。 */
  n: number;
  /** 最後一次被用的卡片建立時間（UTC ISO）。 */
  last_used: string;
}

export const TAG_SORTS = ['count', 'recent', 'name'] as const;
export type TagSort = (typeof TAG_SORTS)[number];

/**
 * 三種排法對應三個問題，所以它們是並列的選項而不是一個預設加兩個例外：
 * 「哪些標籤是我的主幹」（count）、「我最近在寫什麼」（recent）、
 * 「那個字開頭是什麼來著」（name）。
 *
 * `name` 對中文是碼位序，不是筆畫也不是注音——介面上因此叫「名稱」而不是
 * 「字典序」，後者會承諾一個這裡給不出來的東西。
 */
const TAG_ORDER: Record<TagSort, string> = {
  count: 'n DESC, tag ASC',
  recent: 'last_used DESC, tag ASC',
  name: 'tag ASC',
};

/**
 * 標籤的用量。
 *
 * `last_used` 需要 JOIN 回 cards——tags 表只有 card_id，沒有時間。
 * 這裡不做成一張物化的統計表：標籤表的量級是幾百列，一次 GROUP BY 就夠，
 * 而物化就要在每一次寫入與刪除時維護它，多一個會跟事實分岔的東西。
 */
export function tagCounts(idx: IndexDb, sort: TagSort = 'count'): TagCount[] {
  return idx.s(
      `SELECT t.tag AS tag, COUNT(*) AS n, MAX(c.created) AS last_used
         FROM tags t JOIN cards c ON c.id = t.card_id
        GROUP BY t.tag
        ORDER BY ${TAG_ORDER[sort]}`,
    )
    .all() as TagCount[];
}

// -------------------------------------------------------------- 工作狀態清單

/**
 * 沒有人指向它。
 *
 * 三份待辦清單問的是同一個問題：**這張卡有沒有被接住。**
 * 沒有人指向它，就代表沒有人接手，那它就是需要再確認一次的東西。
 * 這不是型別或標籤的羅列，是一次過濾之後剩下的待處理項。
 */
const NO_INBOUND = 'NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = c.id)';

function listOf(idx: IndexDb, where: string, params: unknown[] = []): CardRowWithTags[] {
  const rows = idx.s(
    `SELECT c.* FROM cards c WHERE ${where} ORDER BY c.created DESC, ${idDesc('c.id')}`,
  ).all(...params) as CardRow[];
  return rows.map((r) => ({ ...r, tags: tagsOf(idx, r.id) }));
}

/**
 * 待思考：收進來但沒有人接手。
 *
 * 不區分母卡與節錄——兩者都是 original，同一條判準。摘錄不是「還沒消化」，
 * 是把待辦從整篇文章縮小到那幾段：你切開它，代表你讀過並挑出了值得的部分。
 * 代價是先隨手摘一句再回頭細讀時，整篇會提早離開清單。接受。
 *
 * 這是唯一會主動增長的清單——每存一篇文章就多一項。
 */
const PENDING = `c.type = 'original' AND ${NO_INBOUND}`;

/** 碎片：沒有被撿起來用過的隨手記。 */
const LOOSE_FLEETING = `c.type = 'fleeting' AND ${NO_INBOUND}`;

/**
 * 初步想法：兩頭都懸空的想法。
 *
 * 比另外兩份多一個條件（出向也不能有）：它的問題不只是沒人接手，
 * 是它自己也沒有接住任何東西——一個既沒有依據、也沒有被使用的主張。
 */
const LOOSE_THINKING = `c.type = 'thinking' AND c.link_count = 0 AND ${NO_INBOUND}`;

/**
 * 沉澱：還在反芻期內、仍然改得動的卡片。界線由呼叫端算好傳進來。
 *
 * 兩個條件都要：時間還沒到（R5），而且還沒有人指向它（R6）。
 * 被指向就定案，那一刻它就不再屬於「還可以動的東西」——
 * 這跟關閉編輯、禁止刪除是同一個判準，只是在這裡寫成 SQL。
 */
const SETTLING = `c.created > ? AND ${NO_INBOUND}`;

/**
 * R6：有沒有任何卡片指向它。
 *
 * 「被指向」是定案的判準，所以它值得一個自己的名字，而不是讓呼叫端
 * 去數 backLinks 的長度——那會讓「為什麼要數」這件事消失在呼叫端。
 */
export function isCited(idx: IndexDb, id: string): boolean {
  return idx.s('SELECT 1 FROM links WHERE target_id = ? LIMIT 1').get(id) !== undefined;
}

export function pending(idx: IndexDb): CardRowWithTags[] {
  return listOf(idx, PENDING);
}

export function looseFleeting(idx: IndexDb): CardRowWithTags[] {
  return listOf(idx, LOOSE_FLEETING);
}

export function looseThinking(idx: IndexDb): CardRowWithTags[] {
  return listOf(idx, LOOSE_THINKING);
}

export function settling(idx: IndexDb, since: string): CardRowWithTags[] {
  return listOf(idx, SETTLING, [since]);
}

// -------------------------------------------------------------- 列表項的補充資料

/** 入向連結數，以及其中有幾則是重述。A.6 的 original 列表項要用。 */
export function inboundBreakdown(idx: IndexDb, id: string): { total: number; restatements: number } {
  const row = idx.s(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN s.type = 'restatement' THEN 1 ELSE 0 END) AS restatements
       FROM links l LEFT JOIN cards s ON s.id = l.source_id
      WHERE l.target_id = ?`,
  ).get(id) as { total: number; restatements: number | null };
  return { total: row.total, restatements: row.restatements ?? 0 };
}

/** 這張重述在講哪份原始資料。找不到時 null。 */
export function aboutTarget(idx: IndexDb, id: string): { id: string; title: string } | null {
  const row = idx.s(
    `SELECT c.id AS id, c.title AS title
       FROM links l JOIN cards c ON c.id = l.target_id
      WHERE l.source_id = ? AND l.rel = 'about' AND c.type = 'original'
      ORDER BY ${idDesc('l.target_id')} LIMIT 1`,
  ).get(id) as { id: string; title: string } | undefined;
  return row ?? null;
}

export interface SearchRow extends CardRowWithTags {
  /** 命中的那一小段，命中的字詞被哨符包著（見 schema.ts 的 HIT_OPEN）。 */
  frag: string;
}

/** 片段抓幾個 token。逐字切開之後一個中文字就是一個 token，32 大約是兩行。 */
const SNIPPET_TOKENS = 32;

/**
 * 全文檢索。
 *
 * `snippet` 的第一個參數只吃**表名**，給 alias 會說「no such column」，
 * 所以這句刻意不替 cards_fts 取別名。欄位號給 -1 讓 FTS5 自己挑命中最多的
 * 那一欄：碎片的內容在 title（A.5 的欄位反轉），其餘型別在 body，
 * 這樣兩種都不必在這裡分岔。
 *
 * `char(2)` / `char(3)` 就是 schema.ts 的 HIT_OPEN / HIT_CLOSE。
 */
export function search(
  idx: IndexDb,
  q: string,
  opts: { limit?: number; type?: string } = {},
): SearchRow[] {
  const match = ftsQuery(q);
  if (!match) return [];
  const limit = opts.limit ?? 50;
  const typed = opts.type !== undefined && opts.type !== '';
  let rows: (CardRow & { frag: string })[];
  try {
    rows = idx.s(
        `SELECT c.*, snippet(cards_fts, -1, char(2), char(3), '…', ${SNIPPET_TOKENS}) AS frag
           FROM cards_fts JOIN cards c ON c.id = cards_fts.id
          WHERE cards_fts MATCH ?${typed ? ' AND c.type = ?' : ''}
          ORDER BY rank LIMIT ?`,
      )
      .all(...(typed ? [match, opts.type, limit] : [match, limit])) as (CardRow & {
      frag: string;
    })[];
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
