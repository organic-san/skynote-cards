import { createHash } from 'node:crypto';

/**
 * 卡片的遠端存放處（App Engine 上是 Cloud Storage bucket）。
 *
 * 有設定的時候，**它才是唯一真相**：寫入要先存進這裡、成功了才算數，
 * 本機的 cards/ 只是開機時從它與 git 對帳出來的副本，給讀取與索引用。
 * 沒設定的時候（本機開發、測試、VM）用 NO_STORE，每個動作都是空操作，
 * 系統的行為跟沒有這一層時完全一樣：本機檔案就是真相。
 *
 * 物件名稱就是相對於語料庫根目錄的路徑（`cards/<id>.md`），只放卡片。
 * `tags.yml` 是手工編輯、經 git 進來的設定檔，不進 bucket（見 store/tags.ts）。
 */

export interface StoredObject {
  name: string;
  /** base64 的 MD5，跟本機檔案比對用，不必下載內容。 */
  md5: string;
  /**
   * 這份內容的 git blob 雜湊，與它是從哪一份改出來的（`base`）。
   * 本程式上傳的物件一定兩個都有；從別處（gcloud、主控台）放進來的物件沒有，是 null。
   * 對帳時靠這兩個值分辨「bucket 比較新」與「bucket 是舊的」，見 reconcile.ts。
   */
  blob: string | null;
  base: string | null;
}

export interface PutOptions {
  /** 這份內容的 git blob 雜湊。 */
  blob: string;
  /**
   * 這份內容是從哪一份改出來的：本機原本那份的 blob 雜湊，新卡是 NO_BASE。
   * 與 `blob` 相同代表「這是 git 那一份的副本」，不是本程式的寫入。
   */
  base: string;
  /** 0 = 物件必須還不存在。新卡用它：ID 萬一撞了，寧可失敗也不覆蓋。 */
  ifGenerationMatch?: number;
}

/** 新卡沒有「改自哪一份」。用一個不可能是雜湊的字串，不用空字串（metadata 值不收空字串）。 */
export const NO_BASE = 'none';

export interface CorpusStore {
  readonly kind: 'none' | 'gcs';
  /** 給 /_health 與日誌看的，例如 `gs://my-bucket`。 */
  readonly label: string;
  /** 列出所有卡片物件（`cards/` 底下）。 */
  list(): Promise<StoredObject[]>;
  get(name: string): Promise<Buffer>;
  put(name: string, content: Buffer | string, opts: PutOptions): Promise<void>;
  /** 物件本來就不存在也算成功。 */
  delete(name: string): Promise<void>;
}

/** 沒有遠端：每個動作都不做事。 */
export const NO_STORE: CorpusStore = {
  kind: 'none',
  label: 'none',
  list: async () => [],
  get: async (name) => {
    throw new Error(`沒有設定遠端存放處，讀不到 ${name}`);
  },
  put: async () => {},
  delete: async () => {},
};

/** 寫入被前提條件擋下（新卡的 ID 已經有物件）。 */
export class StoreConflictError extends Error {
  constructor(name: string) {
    super(`${name} 已經存在，沒有覆蓋`);
    this.name = 'StoreConflictError';
  }
}

export function cardObjectName(id: string): string {
  return `cards/${id}.md`;
}

export const CARD_OBJECT = /^cards\/[^/]+\.md$/;

/**
 * git 對這份內容算出的 blob 雜湊，跟 `git hash-object` 同一個值。
 * 用它問「這份內容有沒有在 git 歷史裡出現過」，不必另外跑一個 git 行程。
 */
export function blobHash(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** Cloud Storage 物件的 md5Hash 欄位的格式：base64 的 MD5。 */
export function md5Base64(content: Buffer | string): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('md5').update(buf).digest('base64');
}
