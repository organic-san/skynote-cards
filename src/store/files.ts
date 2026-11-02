import fs from 'node:fs';
import path from 'node:path';
import type { Card, CardMeta } from '../domain/types.ts';
import { parseCard, serializeCard } from '../domain/card.ts';

/**
 * 卡片檔案的讀寫。沒有設定遠端存放處時，檔案是唯一真相；
 * 有設定時（App Engine），真相在 bucket，這裡是它的副本（見 store/remote.ts）。
 * 這是唯一碰 cards/ 的模組，寫入動作有三種：建立、反芻期內重寫、反芻期內刪除。
 * 對帳（reconcile.ts）用的是同一支原子寫入。
 *
 * 環境（v3.1）是 cards/ 底下的一層資料夾：`cards/{id}.md` 沒有環境，
 * `cards/{環境}/{id}.md` 屬於那個環境。卡片檔不記錄自己在哪個環境——
 * 環境的身分就是資料夾名稱，所以既有的卡不必改寫，日後搬動也不必改內容。
 * ID 全域唯一；依 ID 找檔案要看過每一個資料夾，不問索引：檔案才是真相。
 */

export function cardsDir(corpusPath: string): string {
  return path.join(corpusPath, 'cards');
}

/** 一個環境的資料夾。空字串是沒有環境，也就是 cards/ 本身。 */
export function envDir(corpusPath: string, env: string): string {
  return env === '' ? cardsDir(corpusPath) : path.join(cardsDir(corpusPath), env);
}

export function cardPath(corpusPath: string, id: string, env = ''): string {
  return path.join(envDir(corpusPath, env), `${id}.md`);
}

/** 相對於語料庫根目錄的路徑，斜線分隔。git 與 bucket 的物件名稱都用這個。 */
export function cardRelPath(id: string, env = ''): string {
  return env === '' ? `cards/${id}.md` : `cards/${env}/${id}.md`;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * cards/ 底下的環境，依名稱排序。
 * 以 `.` 開頭的資料夾不算：名稱規則不允許（見 service/envs.ts），那是工具留下的東西。
 */
export function listEnvDirs(corpusPath: string): string[] {
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(byCodePoint);
}

/**
 * 這個環境在不在。沒有環境永遠在。
 * 比對的是實際列出來的資料夾，不是拼路徑去問——`..` 之類的名字因此不會走出 cards/。
 */
export function envExists(corpusPath: string, env: string): boolean {
  return env === '' || listEnvDirs(corpusPath).includes(env);
}

export interface CardFile {
  id: string;
  env: string;
  /** 相對於語料庫根目錄，斜線分隔（cardRelPath）。 */
  rel: string;
}

/**
 * 語料庫裡的每一個卡片檔，依 ID 由小到大；同一個 ID 出現在兩個資料夾時，
 * 沒有環境的排前面，其餘依環境名稱。findCard 找的是同一個順序的第一個。
 *
 * `nested` 是環境底下的資料夾。環境只有一層，那些資料夾裡的檔案不會被讀，
 * 列出來讓重建報告說一聲——手動搬檔時多套一層是很容易犯的錯。
 */
export function listCardFiles(corpusPath: string): { files: CardFile[]; nested: string[] } {
  const files: CardFile[] = [];
  const nested: string[] = [];
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return { files, nested };
  for (const env of ['', ...listEnvDirs(corpusPath)]) {
    for (const d of fs.readdirSync(envDir(corpusPath, env), { withFileTypes: true })) {
      if (d.isFile() && d.name.endsWith('.md')) {
        const id = d.name.slice(0, -3);
        files.push({ id, env, rel: cardRelPath(id, env) });
      } else if (env !== '' && d.isDirectory()) {
        nested.push(`cards/${env}/${d.name}/`);
      }
    }
  }
  // sort 是穩定的，同 ID 的兩份維持上面「沒有環境先、再依名稱」的順序。
  files.sort((a, b) => compareFileIds(a.id, b.id));
  return { files, nested };
}

/** 檔名不保證是合法 ID，BigInt 可能丟例外，退回字串比較。 */
function compareFileIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return byCodePoint(a, b);
  }
}

export function countCardFiles(corpusPath: string): number {
  return listCardFiles(corpusPath).files.length;
}

/**
 * 一張卡在哪個環境。沒有環境的先找，其餘依名稱；找不到回 null。
 * 環境只有幾個，逐一資料夾問一次就夠，不必為它建一份對照表。
 */
export function findCard(corpusPath: string, id: string): { env: string; file: string } | null {
  if (id === '' || /[/\\]/.test(id) || id.startsWith('.')) return null;
  for (const env of ['', ...listEnvDirs(corpusPath)]) {
    const file = cardPath(corpusPath, id, env);
    if (fs.existsSync(file)) return { env, file };
  }
  return null;
}

export function cardExists(corpusPath: string, id: string): boolean {
  return findCard(corpusPath, id) !== null;
}

/** 卡片與它所在的環境。找不到就丟 ENOENT，跟直接讀檔一樣。 */
export function readCardWithEnv(corpusPath: string, id: string): { card: Card; env: string } {
  const found = findCard(corpusPath, id);
  if (!found) {
    throw Object.assign(new Error(`ENOENT: 找不到卡片 ${id}`), { code: 'ENOENT' });
  }
  return { card: parseCard(fs.readFileSync(found.file, 'utf8'), id), env: found.env };
}

export function readCard(corpusPath: string, id: string): Card {
  return readCardWithEnv(corpusPath, id).card;
}

/** 只取 frontmatter。 */
export function readCardMeta(corpusPath: string, id: string): CardMeta {
  const c = readCard(corpusPath, id);
  const { body: _body, ...meta } = c;
  return meta;
}

// ---------------------------------------------------------------- 寫入

export function writeCardFile(corpusPath: string, card: Card, env = ''): string {
  return writeCardContent(corpusPath, card.id, serializeCard(card), env);
}

/** 已經序列化好的卡片內容。寫入路徑要先把同一份內容傳上遠端，所以序列化只做一次。 */
export function writeCardContent(corpusPath: string, id: string, content: string, env = ''): string {
  return writeFileAtomic(cardPath(corpusPath, id, env), content);
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
export function deleteCardFile(corpusPath: string, id: string, env = ''): void {
  fs.rmSync(cardPath(corpusPath, id, env), { force: true });
}

// ---------------------------------------------------------------- 環境的資料夾

/**
 * 建立環境就是開一個資料夾。空資料夾不會進 git，也不會進 bucket——
 * 沒有卡片的環境沒有東西需要備份，App Engine 換機器時它就不在了，寫進第一張卡才留得住。
 */
export function createEnvDir(corpusPath: string, env: string): void {
  fs.mkdirSync(envDir(corpusPath, env), { recursive: true });
}

/** 環境改名就是資料夾改名。裡面的卡片內容逐位元不變。 */
export function renameEnvDir(corpusPath: string, from: string, to: string): void {
  fs.renameSync(envDir(corpusPath, from), envDir(corpusPath, to));
}
