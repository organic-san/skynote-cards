import fs from 'node:fs';
import path from 'node:path';
import type { Card } from '../../domain/types.ts';
import { CardParseError, parseCard } from '../../domain/card.ts';
import { compareIds } from '../../domain/id.ts';
import { cardsDir, listCardIds } from '../files.ts';
import { openDb, segmentCjk } from './schema.ts';

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

/**
 * 從 cards/*.md 在 `tmpPath` 建一份全新的索引，建完就關掉。
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
    duration_ms: 0,
  };

  const ids = listCardIds(corpusPath);
  report.files = ids.length;
  const dir = cardsDir(corpusPath);
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
  return report;
}
