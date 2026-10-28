import { randomUUID } from 'node:crypto';
import {
  CARD_OBJECT,
  StoreConflictError,
  md5Base64,
  type CorpusStore,
  type PutOptions,
  type StoredObject,
} from './remote.ts';

/**
 * Cloud Storage 與 GCP 的 metadata server、Secret Manager，全部直接打 REST API。
 *
 * 不用官方的 client 套件：這裡只需要列出、讀、寫、刪四個動作，
 * 為了它們拉進一整串依賴，App Engine F1 的 384MB 記憶體與每次部署的
 * 安裝時間都要付錢，而 VM 那邊合併之後也得在 1GB 的機器上跑一次大的 `npm ci`。
 * 代價是重試與認證要自己寫——下面那兩段就是。
 */

export type FetchLike = typeof fetch;
export type TokenSource = () => Promise<string>;

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';
const SECRETS = 'https://secretmanager.googleapis.com/v1';

/** 等這麼久之後重試。只對暫時性的錯誤（網路、429、5xx）重試。 */
const RETRY_DELAYS_MS = [200, 800, 2000];
/** 單一次請求的上限。卡片是幾 KB 的文字，十秒還沒回來就是卡住了。 */
const ATTEMPT_TIMEOUT_MS = 10_000;

export class HttpError extends Error {
  readonly status: number;
  /** 這是重試之後才拿到的回應（前一次的結果不明）。 */
  readonly retried: boolean;

  // 欄位不寫成建構子參數：測試與開發模式用 Node 直接去掉型別執行，那種語法它不收。
  constructor(status: number, what: string, body: string, retried = false) {
    super(`${what}: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.retried = retried;
  }
}

// ---------------------------------------------------------------- 認證

/**
 * 執行環境服務帳號的 access token，從 metadata server 拿，快取到過期前一分鐘。
 *
 * 本機想對真的 bucket 試跑時，設 `GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`，
 * 就不去問 metadata server（本機沒有那台）。那個 token 一小時後失效，只適合手動試。
 */
export function metadataTokenSource(fetchImpl: FetchLike = fetch): TokenSource {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    const fromEnv = process.env.GCP_ACCESS_TOKEN;
    if (fromEnv) return fromEnv;
    if (cached && Date.now() < cached.until) return cached.token;
    let res: Response;
    try {
      res = await fetchImpl(`${METADATA}/instance/service-accounts/default/token`, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `連不到 metadata server 拿 access token（不在 GCP 上？本機試跑可以設 GCP_ACCESS_TOKEN）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) throw new HttpError(res.status, '取得 access token', await res.text());
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = {
      token: json.access_token,
      until: Date.now() + Math.max(0, json.expires_in - 60) * 1000,
    };
    return json.access_token;
  };
}

/** metadata server 上的一個值，例如 `project/numeric-project-id`。 */
export async function metadataValue(key: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const res = await fetchImpl(`${METADATA}/${key}`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, `讀取 metadata ${key}`, await res.text());
  return (await res.text()).trim();
}

/** Secret Manager 裡一個 secret 的最新版本，解碼成字串、去掉首尾空白。 */
export async function accessSecret(
  project: string,
  secret: string,
  token: TokenSource,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = `${SECRETS}/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}/versions/latest:access`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${await token()}` },
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, `讀取 secret ${secret}`, await res.text());
  const json = (await res.json()) as { payload?: { data?: string } };
  const data = json.payload?.data;
  if (!data) throw new Error(`secret ${secret} 是空的`);
  return Buffer.from(data, 'base64').toString('utf8').trim();
}

// ---------------------------------------------------------------- bucket

export interface GcsStoreOptions {
  bucket: string;
  token: TokenSource;
  fetch?: FetchLike;
  /** 測試用：把重試的等待縮成 0。 */
  retryDelaysMs?: readonly number[];
}

interface GcsObject {
  name: string;
  md5Hash?: string;
  generation?: string;
  metadata?: Record<string, string>;
}

export class GcsStore implements CorpusStore {
  readonly kind = 'gcs' as const;
  readonly label: string;
  private readonly bucket: string;
  private readonly token: TokenSource;
  private readonly fetchImpl: FetchLike;
  private readonly delays: readonly number[];

  constructor(opts: GcsStoreOptions) {
    this.bucket = opts.bucket;
    this.label = `gs://${opts.bucket}`;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async list(): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        prefix: 'cards/',
        fields: 'items(name,md5Hash,generation,metadata),nextPageToken',
        maxResults: '1000',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.send('列出物件', () => ({
        method: 'GET',
        url: `${STORAGE}/b/${this.bucket}/o?${q}`,
      }));
      const json = (await res.json()) as { items?: GcsObject[]; nextPageToken?: string };
      for (const o of json.items ?? []) {
        if (!CARD_OBJECT.test(o.name)) continue;
        out.push({
          name: o.name,
          md5: o.md5Hash ?? '',
          blob: o.metadata?.['skynote-blob'] ?? null,
          base: o.metadata?.['skynote-base'] ?? null,
        });
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }

  async get(name: string): Promise<Buffer> {
    const res = await this.send(`讀取 ${name}`, () => ({
      method: 'GET',
      url: `${this.objectUrl(name)}?alt=media`,
    }));
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 一次 multipart 上傳：內容與 metadata 同一個請求，不會出現「內容到了、
   * 標記還沒到」的中間狀態——對帳靠的就是那兩個標記。
   */
  async put(name: string, content: Buffer | string, opts: PutOptions): Promise<void> {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const boundary = `skynote-${randomUUID()}`;
    const meta = JSON.stringify({
      name,
      contentType: 'text/markdown; charset=utf-8',
      metadata: { 'skynote-blob': opts.blob, 'skynote-base': opts.base },
    });
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: text/markdown; charset=utf-8\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const q = new URLSearchParams({ uploadType: 'multipart' });
    if (opts.ifGenerationMatch !== undefined) q.set('ifGenerationMatch', String(opts.ifGenerationMatch));

    try {
      await this.send(`寫入 ${name}`, () => ({
        method: 'POST',
        url: `${UPLOAD}/b/${this.bucket}/o?${q}`,
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      }));
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 412) throw err;
      // 前提條件不成立。重試過的話，可能是第一次其實寫進去了、只是回應沒收到——
      // 內容一樣就算成功；不一樣才是真的撞號。
      if (err.retried && (await this.md5Of(name)) === md5Base64(body)) return;
      throw new StoreConflictError(name);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.send(`刪除 ${name}`, () => ({ method: 'DELETE', url: this.objectUrl(name) }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return;
      throw err;
    }
  }

  private async md5Of(name: string): Promise<string | null> {
    try {
      const res = await this.send(`讀取 ${name} 的 md5`, () => ({
        method: 'GET',
        url: `${this.objectUrl(name)}?fields=md5Hash`,
      }));
      return ((await res.json()) as { md5Hash?: string }).md5Hash ?? null;
    } catch {
      return null;
    }
  }

  private objectUrl(name: string): string {
    return `${STORAGE}/b/${this.bucket}/o/${encodeURIComponent(name)}`;
  }

  /**
   * 送出一個請求；網路錯誤、429、5xx 等一下再試，其他狀態碼直接丟 HttpError。
   *
   * 四個動作都可以安全重試：列出與讀取沒有副作用；刪除不存在的物件算成功；
   * 新卡的上傳帶著「必須不存在」的前提，重送也不會覆蓋（見 put 的 412）；
   * 修改的上傳重送的是同一份內容。
   */
  private async send(
    what: string,
    build: () => { method: string; url: string; headers?: Record<string, string>; body?: Buffer },
  ): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.delays.length; attempt += 1) {
      if (attempt > 0) await sleep(this.delays[attempt - 1] ?? 0);
      const req = build();
      let res: Response;
      try {
        res = await this.fetchImpl(req.url, {
          method: req.method,
          headers: { authorization: `Bearer ${await this.token()}`, ...req.headers },
          body: req.body,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const error = new HttpError(res.status, what, text, attempt > 0);
      if (res.status === 429 || res.status >= 500) {
        lastError = error;
        continue;
      }
      throw error;
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`${what}: 失敗`);
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
