import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Card } from './types.ts';
import { CardParseError, cardsDir, listCardIds, parseCard } from './cardfile.ts';
import { compareIds } from './id.ts';

/**
 * SQLite 索引。這是投影，不是儲存：任何時候刪掉 index.db，
 * rebuild() 都要能從 cards/*.md 產生完全等價的內容。
 * 因此這個模組只讀語料庫，從不寫入。
 */

// ---------------------------------------------------------------- schema

/**
 * schema 改版就換這個號碼。索引只是投影，發現版本不合就整個丟掉重建，
 * 不需要也不應該寫遷移腳本。
 */
const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE cards (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  created     TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  provenance  TEXT,
  revised     TEXT,
  body        TEXT NOT NULL,
  link_count  INTEGER NOT NULL,
  tag_count   INTEGER NOT NULL
);

CREATE TABLE tags (
  card_id TEXT NOT NULL,
  tag     TEXT NOT NULL
);

CREATE TABLE links (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rel       TEXT NOT NULL
);

CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_source ON links(source_id);
CREATE INDEX idx_tags_tag     ON tags(tag);
CREATE INDEX idx_cards_type   ON cards(type);
CREATE INDEX idx_cards_created ON cards(created);

CREATE VIRTUAL TABLE cards_fts USING fts5(
  id UNINDEXED, title, body, tokenize='unicode61'
);
`;

/** 平假名、片假名、擴充 A 區、基本區、相容漢字。 */
const CJK_RANGE = '぀-ヿ㐀-䶿一-鿿豈-﫿';
const CJK_ONE = new RegExp('[' + CJK_RANGE + ']');
const CJK_EACH = new RegExp('[' + CJK_RANGE + ']', 'g');
/** 一段連續中日文，或一段連續的非中日文非空白。 */
const CJK_CHUNKS = new RegExp(
  '[' + CJK_RANGE + ']+|[^' + CJK_RANGE + '\\s]+',
  'g',
);

/**
 * 把每一個中日文字前後都加上空白，讓 FTS 逐字建索引。
 *
 * unicode61 不切中日韓詞，一整串中文會是一個 token，
 * 於是「分解」找不到「近可分解系統」——只有正好從 token 開頭比對得到的
 * 才找得出來。逐字切開之後，查詢用 phrase 比對就等於子字串比對。
 *
 * 只影響索引，卡片檔案完全不動。
 */
export function segmentCjk(text: string): string {
  return text.replace(CJK_EACH, (c) => ` ${c} `);
}

/**
 * ID 存成 TEXT，但字串排序不等於數值排序：ID 位數會隨時間增加
 * （2026 年內就會從 17 位變成 18 位），純字串排序會在跨位數時整個錯掉。
 * 先比長度再比字串，等價於數值比較。
 */
const ID_DESC = 'LENGTH(%s) DESC, %s DESC';
function idDesc(col: string): string {
  return ID_DESC.replaceAll('%s', col);
}

// ---------------------------------------------------------------- 型別

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

export interface BadLink {
  source_id: string;
  target_id: string;
  rel: string;
  reason: 'missing' | 'order';
}

export interface ReindexReport {
  files: number;
  indexed: number;
  failures: { file: string; error: string }[];
  bad_links: BadLink[];
  duration_ms: number;
}

// ---------------------------------------------------------------- Index

export class CardIndex {
  private db: Database.Database;
  private readonly indexPath: string;
  private readonly corpusPath: string;
  /** 同一句 SQL 只準備一次。換資料庫時整個清掉。 */
  private stmts = new Map<string, Database.Statement>();

  constructor(indexPath: string, corpusPath: string) {
    this.indexPath = indexPath;
    this.corpusPath = corpusPath;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    this.db = openDb(indexPath);
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /**
   * 取得一句 SQL 的 prepared statement。
   *
   * prepare 要解析與規劃，每次查詢都重做一次是白費工；更要緊的是那會
   * 製造大量短命的 Statement 物件，全部要等垃圾回收去清。
   * 這裡的 SQL 都是固定字串（動態的部分只有少數幾種組合），所以以
   * SQL 當鍵是安全的，快取不會無限長大。
   */
  private s(sql: string): Database.Statement {
    let stmt = this.stmts.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  get handle(): Database.Database {
    return this.db;
  }

  // -------------------------------------------------------------- 寫入

  /** 把一張卡片寫進索引。同 ID 先清掉舊的列，所以可重複呼叫。 */
  putCard(card: Card): void {
    const tx = this.db.transaction((c: Card) => {
      this.s('DELETE FROM cards WHERE id = ?').run(c.id);
      this.s('DELETE FROM tags WHERE card_id = ?').run(c.id);
      this.s('DELETE FROM links WHERE source_id = ?').run(c.id);
      this.s('DELETE FROM cards_fts WHERE id = ?').run(c.id);

      this.s(
          `INSERT INTO cards
             (id, type, created, title, url, provenance, revised, body, link_count, tag_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.id,
          c.type,
          c.created,
          c.title,
          c.url,
          c.provenance,
          c.revised,
          c.body,
          c.links.length,
          c.tags.length,
        );

      const insTag = this.s('INSERT INTO tags (card_id, tag) VALUES (?, ?)');
      for (const t of c.tags) insTag.run(c.id, t);

      // 壞連結照實寫進索引：索引是檔案的等價投影，不是檔案的修訂版。
      // 哪些連結壞掉由重建報告指出。
      const insLink = this.s(
        'INSERT INTO links (source_id, target_id, rel) VALUES (?, ?, ?)',
      );
      for (const l of c.links) insLink.run(c.id, l.to, l.rel);

      this.s('INSERT INTO cards_fts (id, title, body) VALUES (?, ?, ?)')
        .run(c.id, segmentCjk(c.title), segmentCjk(c.body));
    });
    tx(card);
  }

  // -------------------------------------------------------------- 查詢

  countCards(): number {
    return (this.s('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
  }

  getCard(id: string): CardRowWithTags | null {
    const row = this.s('SELECT * FROM cards WHERE id = ?').get(id) as
      | CardRow
      | undefined;
    if (!row) return null;
    return { ...row, tags: this.tagsOf(id) };
  }

  tagsOf(id: string): string[] {
    return (
      this.s('SELECT tag FROM tags WHERE card_id = ? ORDER BY rowid').all(id) as {
        tag: string;
      }[]
    ).map((r) => r.tag);
  }

  typeOf(id: string): string | null {
    const row = this.s('SELECT type FROM cards WHERE id = ?').get(id) as
      | { type: string }
      | undefined;
    return row?.type ?? null;
  }

  listCards(opts: { type?: string; tag?: string; limit: number; offset: number }): {
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
      this.s(`SELECT COUNT(*) AS n ${from}${whereSql}`).get(...params) as { n: number }
    ).n;

    const rows = this.s(
        `SELECT c.* ${from}${whereSql} ORDER BY c.created DESC, ${idDesc('c.id')} LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as CardRow[];

    return { rows: rows.map((r) => ({ ...r, tags: this.tagsOf(r.id) })), total };
  }

  /** 出向連結：這張卡指向誰。target 不存在時 title 為 null。 */
  outLinks(id: string): LinkRow[] {
    return this.s(
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
  backLinks(id: string): LinkRow[] {
    return this.s(
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
  linkTree(rootId: string, direction: 'in' | 'out', maxDepth: number): ThreadNode[] {
    const seen = new Set<string>([rootId]);
    const expand = (id: string, depth: number): ThreadNode[] => {
      const rows = direction === 'in' ? this.backLinks(id) : this.outLinks(id);
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
  linkTargetTypes(id: string): Map<string, string | null> {
    const m = new Map<string, string | null>();
    for (const l of this.outLinks(id)) m.set(l.id, l.type);
    return m;
  }

  tagCounts(): { tag: string; n: number }[] {
    return this.s('SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag ASC')
      .all() as { tag: string; n: number }[];
  }

  /** type = 'thinking' 且沒有任何連結的卡片：目前所有沒有依據的信念。 */
  orphans(): CardRowWithTags[] {
    const rows = this.s(
        `SELECT * FROM cards WHERE type = 'thinking' AND link_count = 0
          ORDER BY created DESC, ${idDesc('id')}`,
      )
      .all() as CardRow[];
    return rows.map((r) => ({ ...r, tags: this.tagsOf(r.id) }));
  }

  search(q: string, limit = 50): CardRowWithTags[] {
    const match = ftsQuery(q);
    if (!match) return [];
    let rows: CardRow[];
    try {
      rows = this.s(
          `SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.id
            WHERE cards_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(match, limit) as CardRow[];
    } catch {
      return [];
    }
    return rows.map((r) => ({ ...r, tags: this.tagsOf(r.id) }));
  }

  /**
   * 建立表單的連結選擇器：同時支援貼上 ID 與打字搜尋標題。
   * 走 ID 精確比對加標題子字串比對，不走全文檢索——
   * unicode61 不切中文詞，對標題這種短字串 LIKE 反而準。
   */
  pickerSearch(q: string, limit = 10): CardRow[] {
    const term = q.trim();
    if (term === '') return [];
    const like = `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    return this.s(
        `SELECT * FROM cards
          WHERE id = ? OR title LIKE ? ESCAPE '\\'
          ORDER BY (id = ?) DESC, created DESC, ${idDesc('id')}
          LIMIT ?`,
      )
      .all(term, like, term, limit) as CardRow[];
  }

  // -------------------------------------------------------------- 重建

  /**
   * 砍掉重建。冪等，可隨時執行，不需停機也不需備份索引。
   * 先在暫存路徑建好完整的 db，關掉舊連線，rename 覆蓋，重新開啟。
   * rename 之後行程還握著舊 inode，重新開啟這一步不能省。
   */
  rebuild(): ReindexReport {
    const started = Date.now();
    const tmpPath = `${this.indexPath}.rebuild`;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      fs.rmSync(`${tmpPath}${suffix}`, { force: true });
    }

    const fresh = openDb(tmpPath);
    const report: ReindexReport = {
      files: 0,
      indexed: 0,
      failures: [],
      bad_links: [],
      duration_ms: 0,
    };

    const ids = listCardIds(this.corpusPath);
    report.files = ids.length;
    const dir = cardsDir(this.corpusPath);
    const known = new Set(ids);
    const cards: Card[] = [];

    for (const id of ids) {
      const file = path.join(dir, `${id}.md`);
      try {
        const card = parseCard(fs.readFileSync(file, 'utf8'), id);
        if (card.id !== id) {
          throw new CardParseError(`frontmatter 的 id (${card.id}) 與檔名 (${id}) 不符`);
        }
        cards.push(card);
      } catch (err) {
        // 單一檔案壞掉不中斷整體流程。
        report.failures.push({
          file: `cards/${id}.md`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const insert = fresh.transaction((list: Card[]) => {
      const insCard = fresh.prepare(
        `INSERT INTO cards
           (id, type, created, title, url, provenance, revised, body, link_count, tag_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insTag = fresh.prepare('INSERT INTO tags (card_id, tag) VALUES (?, ?)');
      const insLink = fresh.prepare(
        'INSERT INTO links (source_id, target_id, rel) VALUES (?, ?, ?)',
      );
      const insFts = fresh.prepare('INSERT INTO cards_fts (id, title, body) VALUES (?, ?, ?)');
      for (const c of list) {
        insCard.run(
          c.id,
          c.type,
          c.created,
          c.title,
          c.url,
          c.provenance,
          c.revised,
          c.body,
          c.links.length,
          c.tags.length,
        );
        for (const t of c.tags) insTag.run(c.id, t);
        for (const l of c.links) insLink.run(c.id, l.to, l.rel);
        insFts.run(c.id, segmentCjk(c.title), segmentCjk(c.body));
      }
    });
    insert(cards);
    report.indexed = cards.length;

    // 壞連結清單。這是系統唯一會發現資料完整性問題的地方，
    // 兩種壞法都要報：目標不存在，以及目標 ID 不小於來源 ID。
    for (const c of cards) {
      for (const l of c.links) {
        if (!known.has(l.to)) {
          report.bad_links.push({
            source_id: c.id,
            target_id: l.to,
            rel: l.rel,
            reason: 'missing',
          });
          continue;
        }
        let ordered = false;
        try {
          ordered = compareIds(l.to, c.id) < 0;
        } catch {
          ordered = false;
        }
        if (!ordered) {
          report.bad_links.push({
            source_id: c.id,
            target_id: l.to,
            rel: l.rel,
            reason: 'order',
          });
        }
      }
    }

    fresh.close();
    this.stmts.clear();
    this.db.close();
    replaceFile(tmpPath, this.indexPath);
    this.db = openDb(this.indexPath);

    report.duration_ms = Date.now() - started;
    return report;
  }
}

// ---------------------------------------------------------------- helpers

function openDb(file: string): Database.Database {
  const existed = fs.existsSync(file);
  // 主檔不在卻留著 -wal，SQLite 會拿那個 WAL 去復原一個不存在的資料庫。
  // 手動砍索引時很容易只砍主檔，所以這裡自己清乾淨。
  if (!existed) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      fs.rmSync(`${file}${suffix}`, { force: true });
    }
  }
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  // 索引是可拋棄的投影：掉了、壞了，都從 cards/*.md 重建。
  // 所以這裡不該付最高等級的耐久成本——rollback journal 加 synchronous=FULL
  // 會讓每一次寫入把所有髒頁先抄一份到 journal、再寫回 db，中間夾好幾次 fsync。
  // 一篇長文章就是上百次隨機寫，在 IOPS 很低的磁碟上會慢到讓寫入路徑卡住。
  // WAL 是循序附加，NORMAL 在 WAL 下仍然不會損毀資料庫，最壞只是掉最後幾筆——
  // 而那正好是重建就能補回來的東西。
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  if (!existed || !usable(db)) {
    db.exec('DROP TABLE IF EXISTS cards_fts; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS cards;');
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

function usable(db: Database.Database): boolean {
  const version = db.pragma('user_version', { simple: true });
  if (version !== SCHEMA_VERSION) return false;
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cards'`)
    .get();
  return row !== undefined;
}

function replaceFile(from: string, to: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    fs.rmSync(`${to}${suffix}`, { force: true });
  }
  try {
    fs.renameSync(from, to);
  } catch {
    // Windows 不允許 rename 覆蓋既有檔案。
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }
}

/**
 * 把使用者輸入轉成 FTS5 查詢字串。
 *
 * 中日文的連續段逐字切開後當成 phrase：字要照順序連在一起才算命中，
 * 等價於子字串搜尋。其他語言維持整詞加前綴比對。
 */
export function ftsQuery(q: string): string | null {
  const parts: string[] = [];
  const chunks = q.match(CJK_CHUNKS) ?? [];
  for (const chunk of chunks) {
    if (CJK_ONE.test(chunk[0] ?? '')) {
      parts.push(`"${[...chunk].join(' ')}"`);
    } else {
      const t = chunk.replaceAll('"', '""');
      if (t !== '') parts.push(`"${t}"*`);
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}
