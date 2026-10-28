import fs from 'node:fs';
import path from 'node:path';
import type { Card, CardMeta } from '../domain/types.ts';
import { parseCard, serializeCard } from '../domain/card.ts';

/**
 * 卡片檔案的讀寫。沒有設定遠端存放處時，檔案是唯一真相；
 * 有設定時（App Engine），真相在 bucket，這裡是它的副本（見 store/remote.ts）。
 * 這是唯一碰 cards/ 的模組，寫入動作有三種：建立、反芻期內重寫、反芻期內刪除。
 * 對帳（reconcile.ts）用的是同一支原子寫入。
 */

export function cardsDir(corpusPath: string): string {
  return path.join(corpusPath, 'cards');
}

export function cardPath(corpusPath: string, id: string): string {
  return path.join(cardsDir(corpusPath), `${id}.md`);
}

export function cardExists(corpusPath: string, id: string): boolean {
  return fs.existsSync(cardPath(corpusPath, id));
}

/** cards/ 下所有卡片的 ID，依 ID 由小到大。 */
export function listCardIds(corpusPath: string): string[] {
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => {
      // 檔名不保證是合法 ID，BigInt 可能丟例外，退回字串比較。
      try {
        const x = BigInt(a);
        const y = BigInt(b);
        return x < y ? -1 : x > y ? 1 : 0;
      } catch {
        return a < b ? -1 : a > b ? 1 : 0;
      }
    });
}

export function countCardFiles(corpusPath: string): number {
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

export function readCard(corpusPath: string, id: string): Card {
  const raw = fs.readFileSync(cardPath(corpusPath, id), 'utf8');
  return parseCard(raw, id);
}

/** 只取 frontmatter。 */
export function readCardMeta(corpusPath: string, id: string): CardMeta {
  const c = readCard(corpusPath, id);
  const { body: _body, ...meta } = c;
  return meta;
}

// ---------------------------------------------------------------- 寫入

export function writeCardFile(corpusPath: string, card: Card): string {
  return writeCardContent(corpusPath, card.id, serializeCard(card));
}

/** 已經序列化好的卡片內容。寫入路徑要先把同一份內容傳上遠端，所以序列化只做一次。 */
export function writeCardContent(corpusPath: string, id: string, content: string): string {
  return writeFileAtomic(cardPath(corpusPath, id), content);
}

/**
 * 先寫 .tmp、fsync、再 rename。
 * 任何時刻中斷，cards/ 下都不會出現半個檔案。
 */
export function writeFileAtomic(finalPath: string, content: string | Buffer): string {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${finalPath}.tmp`;

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);

  // 目錄項目也要落地，否則 crash 後 rename 可能不見。
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // 有些平台不允許 fsync 目錄，忽略。
  }
  return finalPath;
}

/**
 * R9：刪掉一張卡的檔案。
 *
 * 「刪除不等於抹除」——卡片在建立當下就已經 commit、可能已經 push，
 * 這裡只讓它從 cards/ 消失，內容仍留在 git 歷史裡。那是備份該有的行為。
 */
export function deleteCardFile(corpusPath: string, id: string): void {
  fs.rmSync(cardPath(corpusPath, id), { force: true });
}
