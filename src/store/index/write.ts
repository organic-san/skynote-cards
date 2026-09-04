import type { Card } from '../../domain/types.ts';
import { type IndexDb, segmentCjk } from './schema.ts';

/**
 * 索引的唯一寫入口。索引是投影，所以這裡只接受已經落地的卡片。
 * 同 ID 先清掉舊的列，所以可重複呼叫。
 */
export function putCard(idx: IndexDb, card: Card): void {
  const tx = idx.db.transaction((c: Card) => {
    idx.s('DELETE FROM cards WHERE id = ?').run(c.id);
    idx.s('DELETE FROM tags WHERE card_id = ?').run(c.id);
    idx.s('DELETE FROM links WHERE source_id = ?').run(c.id);
    idx.s('DELETE FROM cards_fts WHERE id = ?').run(c.id);

    idx.s(
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

    const insTag = idx.s('INSERT INTO tags (card_id, tag) VALUES (?, ?)');
    for (const t of c.tags) insTag.run(c.id, t);

    // 壞連結照實寫進索引：索引是檔案的等價投影，不是檔案的修訂版。
    // 哪些連結壞掉由重建報告指出。
    const insLink = idx.s(
      'INSERT INTO links (source_id, target_id, rel) VALUES (?, ?, ?)',
    );
    for (const l of c.links) insLink.run(c.id, l.to, l.rel);

    idx.s('INSERT INTO cards_fts (id, title, body) VALUES (?, ?, ?)')
      .run(c.id, segmentCjk(c.title), segmentCjk(c.body));
  });
  tx(card);
}
