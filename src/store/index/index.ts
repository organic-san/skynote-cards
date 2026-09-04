import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Card } from '../../domain/types.ts';
import { type IndexDb, openDb, replaceFile } from './schema.ts';
import * as q from './query.ts';
import { putCard } from './write.ts';
import { rebuildInto } from './rebuild.ts';

/**
 * SQLite 索引。這是投影，不是儲存：任何時候刪掉 index.db，
 * rebuild() 都要能從 cards/*.md 產生完全等價的內容。
 * 因此這個模組只讀語料庫，從不寫入。
 *
 * 這個類別本身只做三件事：握著 handle、快取 prepared statement、
 * 在重建時換手。查詢與寫入的內容都在 query / write / rebuild 裡。
 */

export type { CardRow, CardRowWithTags, LinkRow, ThreadNode } from './query.ts';
export type { BadLink, ReindexReport, RuleWarning } from './rebuild.ts';
export { ftsQuery, segmentCjk, type IndexDb } from './schema.ts';

import type { CardRow, CardRowWithTags, LinkRow, ThreadNode } from './query.ts';
import type { ReindexReport } from './rebuild.ts';

export class CardIndex implements IndexDb {
  private database: Database.Database;
  private readonly indexPath: string;
  private readonly corpusPath: string;
  /** 同一句 SQL 只準備一次。換資料庫時整個清掉。 */
  private stmts = new Map<string, Database.Statement>();

  constructor(indexPath: string, corpusPath: string) {
    this.indexPath = indexPath;
    this.corpusPath = corpusPath;
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    this.database = openDb(indexPath);
  }

  close(): void {
    this.stmts.clear();
    this.database.close();
  }

  get db(): Database.Database {
    return this.database;
  }

  /**
   * 取得一句 SQL 的 prepared statement。
   *
   * prepare 要解析與規劃，每次查詢都重做一次是白費工；更要緊的是那會
   * 製造大量短命的 Statement 物件，全部要等垃圾回收去清。
   * 這裡的 SQL 都是固定字串（動態的部分只有少數幾種組合），所以以
   * SQL 當鍵是安全的，快取不會無限長大。
   */
  s(sql: string): Database.Statement {
    let stmt = this.stmts.get(sql);
    if (stmt === undefined) {
      stmt = this.database.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  get handle(): Database.Database {
    return this.database;
  }

  // -------------------------------------------------------------- 寫入

  /** 把一張卡片寫進索引。同 ID 先清掉舊的列，所以可重複呼叫。 */
  putCard(card: Card): void {
    putCard(this, card);
  }

  // -------------------------------------------------------------- 查詢

  countCards(): number {
    return q.countCards(this);
  }

  getCard(id: string): CardRowWithTags | null {
    return q.getCard(this, id);
  }

  tagsOf(id: string): string[] {
    return q.tagsOf(this, id);
  }

  typeOf(id: string): string | null {
    return q.typeOf(this, id);
  }

  listCards(opts: { type?: string; tag?: string; limit: number; offset: number }): {
    rows: CardRowWithTags[];
    total: number;
  } {
    return q.listCards(this, opts);
  }

  outLinks(id: string): LinkRow[] {
    return q.outLinks(this, id);
  }

  backLinks(id: string): LinkRow[] {
    return q.backLinks(this, id);
  }

  linkTree(rootId: string, direction: 'in' | 'out', maxDepth: number): ThreadNode[] {
    return q.linkTree(this, rootId, direction, maxDepth);
  }

  tagCounts(): { tag: string; n: number }[] {
    return q.tagCounts(this);
  }

  // ---- 工作狀態清單

  pending(): CardRowWithTags[] {
    return q.pending(this);
  }

  looseFleeting(): CardRowWithTags[] {
    return q.looseFleeting(this);
  }

  looseThinking(): CardRowWithTags[] {
    return q.looseThinking(this);
  }

  settling(since: string): CardRowWithTags[] {
    return q.settling(this, since);
  }

  inboundBreakdown(id: string): { total: number; restatements: number } {
    return q.inboundBreakdown(this, id);
  }

  aboutTarget(id: string): { id: string; title: string } | null {
    return q.aboutTarget(this, id);
  }

  search(query: string, limit = 50): CardRowWithTags[] {
    return q.search(this, query, limit);
  }

  pickerSearch(query: string, limit = 10): CardRow[] {
    return q.pickerSearch(this, query, limit);
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
    const report = rebuildInto(tmpPath, this.corpusPath);

    this.stmts.clear();
    this.database.close();
    replaceFile(tmpPath, this.indexPath);
    this.database = openDb(this.indexPath);

    report.duration_ms = Date.now() - started;
    return report;
  }
}
