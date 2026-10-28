import crypto, { type KeyObject } from 'node:crypto';

/**
 * 驗證 Identity-Aware Proxy 簽的 JWT（`x-goog-iap-jwt-assertion` 標頭）。
 *
 * 這支程式本身不做登入，一切靠前面那一層擋人。在 VM 上那一層是 Cloudflare Access，
 * 在 App Engine 上是 IAP。這裡是第二道：IAP 萬一被關掉、或部署比 IAP 早一步，
 * `appspot.com` 網址會直接對外，沒有這道檢查的話任何人都能讀寫全部卡片。
 * 有了它，沒經過 IAP 的請求一律 403——失敗時是關著的。
 *
 * 規則照 Google 的文件：ES256 簽章、iss 是 IAP、aud 是這個 App Engine app、
 * exp 還沒到、iat 不在未來。
 */

export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
const ISSUER = 'https://cloud.google.com/iap';
const KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
/** 兩台機器的時鐘差。 */
const SKEW_S = 30;
/** 遇到沒見過的 kid 時重新抓公鑰，但兩次之間至少隔這麼久，不讓壞請求逼我們一直抓。 */
const REFETCH_MIN_MS = 10_000;
const KEYS_TTL_MS = 60 * 60_000;

/** 驗過就回傳登入者的 email（或 sub），沒過回 null。 */
export type IapVerifier = (token: string | undefined) => Promise<string | null>;

export interface IapVerifierOptions {
  /** App Engine 是 `/projects/<專案編號>/apps/<專案 ID>`。 */
  audience: string;
  /** 測試用：換掉抓公鑰的方式與時鐘。 */
  fetchKeys?: () => Promise<crypto.JsonWebKey[]>;
  now?: () => number;
}

export function createIapVerifier(opts: IapVerifierOptions): IapVerifier {
  const fetchKeys = opts.fetchKeys ?? fetchIapKeys;
  const now = opts.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  /** 上一次抓成功、上一次嘗試的時間。 */
  let fetchedAt = -Infinity;
  let triedAt = -Infinity;

  const keyFor = async (kid: string): Promise<KeyObject | null> => {
    const wanted = !keys.has(kid) || now() - fetchedAt > KEYS_TTL_MS;
    if (wanted && now() - triedAt >= REFETCH_MIN_MS) {
      triedAt = now();
      try {
        const next = new Map<string, KeyObject>();
        for (const jwk of await fetchKeys()) {
          if (typeof jwk.kid === 'string') {
            next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
          }
        }
        keys = next;
        fetchedAt = now();
      } catch {
        // 抓不到就用手上的；手上沒有就驗不過——關著，不是開著。
      }
    }
    return keys.get(kid) ?? null;
  };

  return async (token) => {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];

    let header: { alg?: string; kid?: string };
    let claims: { iss?: string; aud?: string; exp?: number; iat?: number; email?: string; sub?: string };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') return null;

    const key = await keyFor(header.kid);
    if (!key) return null;
    const signed = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    if (!signed) return null;

    const t = now() / 1000;
    if (claims.iss !== ISSUER || claims.aud !== opts.audience) return null;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) return null;
    if (typeof claims.iat !== 'number' || claims.iat - SKEW_S > t) return null;
    return claims.email ?? claims.sub ?? null;
  };
}

async function fetchIapKeys(): Promise<crypto.JsonWebKey[]> {
  const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`IAP 公鑰: HTTP ${res.status}`);
  return ((await res.json()) as { keys: crypto.JsonWebKey[] }).keys;
}
