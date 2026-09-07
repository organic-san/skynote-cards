import fs from 'node:fs';
import Database from 'better-sqlite3';

/**
 * 索引資料庫本身：schema、開檔、版本檢查，以及幾個所有查詢都要用的字串工具。
 * 這一層不認得卡片，只認得一個 SQLite 檔案該長什麼樣子。
 */

/**
 * write / query / rebuild 共用的資料庫把手。
 *
 * prepared statement 的快取由持有者（CardIndex）提供，
 * 這幾個模組只要求「給我一句 SQL 的 statement」，不管它是不是新的。
 */
export interface IndexDb {
  readonly db: Database.Database;
  s(sql: string): Database.Statement;
}

/**
 * schema 改版就換這個號碼。索引只是投影，發現版本不合就整個丟掉重建，
 * 不需要也不應該寫遷移腳本。
 */
const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE cards (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  created     TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  provenance  TEXT,
  source_author TEXT,
  source_date   TEXT,
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

/*
  ---------------------------------------------------------------- 搜尋片段

  FTS5 的 snippet() 要用一對字串把命中的字詞包起來。這裡用兩個不可見的
  控制字元，而不是直接給 <mark>：片段還要經過 HTML 轉義才能進頁面，
  先放標籤會被轉義成純文字，先轉義又分不出哪些角括號是標籤、哪些是內文。
  控制字元在轉義那一步原樣存活，最後一步再換成標籤（見 present.ts 的 highlight）。
*/
export const HIT_OPEN = '\u0002';
export const HIT_CLOSE = '\u0003';
const HIT_MARKS = HIT_OPEN + HIT_CLOSE;

/**
 * 把 segmentCjk 插進去的空白拿掉。**它是 segmentCjk 的精確反函數。**
 *
 * 索引裡的中日文是逐字切開的（見上方），所以 snippet() 回來的片段長這樣：
 * 「 西  蒙  提  出 」。原樣印出去就是一行被拆散的字。
 *
 * 不能寫成「兩側是中日文就把空白拿掉」，那條規則在三個地方會出錯：
 *
 * - `cat 概念` 的原文本來就有一個空白，兩側各插一個之後變兩個，
 *   整段拿掉就黏成 `cat概念`；
 * - `概念，用來` 的全形逗號**不在** CJK_RANGE 裡（那個區段從 U+3040 起，
 *   不含標點），所以「兩側都是中日文」對它不成立，空隙會留下來；
 * - 兩個相鄰的英文命中 `⟨the⟩ ⟨cat⟩`，中間的空白左右各是一個哨符，
 *   把哨符算進「中日文」就會吃掉它，印出 `thecat`。
 *
 * 所以改成照著 segmentCjk 做過的事逆推：它把每個中日文字 C 換成 ` C `，
 * 於是**每個中日文字的左邊多一個空白、右邊多一個空白**，其餘一律沒動。
 * 這裡就精確地各還一個回去，剩下的空白必然是原文自己的。
 * 哨符夾在中間不影響判斷（它們貼著命中的字詞，不是空白的一部分），
 * 但也不構成拿掉空白的理由——這一點正是上面第三個例子要求的。
 */
const AFTER_CJK = new RegExp('([' + CJK_RANGE + '])([' + HIT_MARKS + ']*) ', 'g');
const BEFORE_CJK = new RegExp(' ([' + HIT_MARKS + ']*)([' + CJK_RANGE + '])', 'g');

export function desegment(s: string): string {
  return s.replace(AFTER_CJK, '$1$2').replace(BEFORE_CJK, '$1$2').trim();
}

/**
 * ID 存成 TEXT，但字串排序不等於數值排序：ID 位數會隨時間增加
 * （2026 年內就會從 17 位變成 18 位），純字串排序會在跨位數時整個錯掉。
 * 先比長度再比字串，等價於數值比較。
 */
const ID_DESC = 'LENGTH(%s) DESC, %s DESC';
export function idDesc(col: string): string {
  return ID_DESC.replaceAll('%s', col);
}

// ---------------------------------------------------------------- helpers

export function openDb(file: string): Database.Database {
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

export function replaceFile(from: string, to: string): void {
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
