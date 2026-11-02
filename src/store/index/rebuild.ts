import fs from 'node:fs';
import path from 'node:path';
import type { Card, CardType } from '../../domain/types.ts';
import { CardParseError, parseCard } from '../../domain/card.ts';
import { compareIds } from '../../domain/id.ts';
import {
  checkFleetingHasNoLinks,
  checkRelMatrix,
  checkRestatementHasSource,
  checkThinkingHasTag,
} from '../../domain/rules.ts';
import { listCardFiles } from '../files.ts';
import { openDb, segmentCjk } from './schema.ts';

export interface BadLink {
  source_id: string;
  target_id: string;
  rel: string;
  reason: 'missing' | 'order';
}

/**
 * R4：規則改動不追溯既有卡片。
 *
 * 違反現行規則的舊卡片列入**警告**，不視為錯誤，不阻斷重建，也不會從
 * 系統裡消失。這跟 `failures` 是兩件事：failures 是連 frontmatter 都解析
 * 不出來的檔案，那些卡片是真的不見了；warnings 的卡片好端端地在，
 * 只是照今天的規則不會被建立出來。
 */
export interface RuleWarning {
  card_id: string;
  message: string;
}

export interface ReindexReport {
  files: number;
  indexed: number;
  failures: { file: string; error: string }[];
  bad_links: BadLink[];
  warnings: RuleWarning[];
  duration_ms: number;
}

/**
 * 從 cards/*.md 與各環境的 cards/{環境}/*.md 在 `tmpPath` 建一份全新的索引，建完就關掉。
 *
 * 換手那一步（關掉舊連線、rename 覆蓋、重新開啟）不在這裡：
 * 誰握著那個 handle，誰負責換。所以回傳的 report 還沒有 duration_ms，
 * 由呼叫端在換完手之後填——重建的耗時包含換手。
 */
export function rebuildInto(tmpPath: string, corpusPath: string): ReindexReport {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(`${tmpPath}${suffix}`, { force: true });
  }

  const fresh = openDb(tmpPath);
  const report: ReindexReport = {
    files: 0,
    indexed: 0,
    failures: [],
    bad_links: [],
    warnings: [],
    duration_ms: 0,
  };

  const { files, nested } = listCardFiles(corpusPath);
  report.files = files.length;
  const known = new Set(files.map((f) => f.id));
  const cards: { card: Card; env: string }[] = [];
  /** 解析成功的卡片的型別，R1 與 R3 判斷目標型別時要用。 */
  const types = new Map<string, CardType>();
  /** 已經進索引的 ID 在哪個檔案。同一個 ID 出現兩次時，報告要說出另一份在哪裡。 */
  const placed = new Map<string, string>();

  for (const nest of nested) {
    report.failures.push({ file: nest, error: '環境只有一層，這個資料夾裡的卡片沒有進索引' });
  }

  for (const f of files) {
    try {
      // ID 全域唯一（v3.1）。在別處搬檔時兩個資料夾各留一份，就會撞在這裡；
      // 先到的那份進索引（沒有環境的先，其餘依環境名稱，跟依 ID 找檔案同一個順序）。
      const first = placed.get(f.id);
      if (first !== undefined) {
        throw new CardParseError(`ID 跟 ${first} 重複，沒有進索引`);
      }
      const card = parseCard(fs.readFileSync(path.join(corpusPath, f.rel), 'utf8'), f.id);
      if (card.id !== f.id) {
        throw new CardParseError(`frontmatter 的 id (${card.id}) 與檔名 (${f.id}) 不符`);
      }
      cards.push({ card, env: f.env });
      types.set(card.id, card.type);
      placed.set(card.id, f.rel);
    } catch (err) {
      // 單一檔案壞掉不中斷整體流程。
      report.failures.push({
        file: f.rel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const insert = fresh.transaction((list: { card: Card; env: string }[]) => {
    const insCard = fresh.prepare(
      `INSERT INTO cards
         (id, env, type, created, title, url, provenance, source_author, source_date,
          revised, body, link_count, tag_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insTag = fresh.prepare('INSERT INTO tags (card_id, tag) VALUES (?, ?)');
    const insLink = fresh.prepare(
      'INSERT INTO links (source_id, target_id, rel) VALUES (?, ?, ?)',
    );
    const insFts = fresh.prepare('INSERT INTO cards_fts (id, title, body) VALUES (?, ?, ?)');
    for (const { card: c, env } of list) {
      insCard.run(
        c.id,
        env,
        c.type,
        c.created,
        c.title,
        c.url,
        c.provenance,
        c.source_author,
        c.source_date,
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
  for (const { card: c } of cards) {
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

  // R4 的警告清單。跑的是**現行**規則，所以規則一放寬，同一批卡就自動
  // 從清單上消失——不需要為既有資料做任何遷移，這正是 R4 買到的東西。
  const typeOf = (id: string): CardType | null => types.get(id) ?? null;
  for (const { card: c } of cards) {
    const messages = [
      ...checkFleetingHasNoLinks(c.type, c.links.length),
      ...checkRestatementHasSource(c.type, c.links, typeOf),
      ...checkRelMatrix(c.type, c.links, typeOf),
      // R11 之前寫的無標籤思考會留在這份清單上。規則不追溯，它們不必被修好。
      ...checkThinkingHasTag(c.type, c.tags),
    ];
    for (const message of messages) report.warnings.push({ card_id: c.id, message });
  }

  fresh.close();
  return report;
}
