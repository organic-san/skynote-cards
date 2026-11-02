import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * public/ 底下的 CSS 與 JS：網址帶著內容的版本，讓瀏覽器可以長期快取。
 *
 * 為什麼要快取——換頁時的閃爍。Ferdium 這類把網頁包在 Electron `<webview>` 裡的
 * 外殼，沒有一般分頁「舊畫面留到新頁畫好為止」的保護（paint holding）：新頁一接手，
 * 舊畫面就沒了，到新頁畫出第一格之前，看到的是外殼自己的底色（深色模式下是一塊黑）。
 * 新頁要等 CSS 才能畫，而 CSS 原本是 no-cache，每換一頁就回伺服器驗證一次——
 * 在 App Engine 上隔著 IAP，那一來一回就是看得見的一閃。CSS 直接從快取拿，
 * 新頁一接手就畫得出來，那個空檔就沒有了。
 *
 * 長期快取不能換來「改了卻看到舊版」（app.ts 那段 no-cache 的理由），所以：
 *
 * - 模板裡的網址一律經過 `assetUrl`，帶上 `?v={內容的雜湊}`。檔案一改，網址就跟著換。
 * - 只有 `v` 等於這台機器上那個檔案現在的版本，才給一年的 immutable 快取。
 *   不帶 `v`、或帶的是別的版本（部署時舊機器接到新頁面發出的請求），照舊 no-cache——
 *   舊內容不會被記在新網址底下一年。
 * - 版本依修改時間與大小快取，變了才重算：開發時改完存檔，下一頁就是新的網址。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(here, '..', '..', 'public');

const PREFIX = '/static/';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

interface Version {
  mtimeMs: number;
  size: number;
  v: string;
}
const versions = new Map<string, Version>();

/** 一個檔案現在的版本：內容 SHA-256 的前 10 碼。讀不到回 null。 */
export function versionOf(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = versions.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.v;
  const v = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  versions.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, v });
  return v;
}

/** 模板用：`/static/css/base.css` → `/static/css/base.css?v=1a2b3c4d5e`。找不到檔案就原樣回去。 */
export function assetUrl(url: string): string {
  if (!url.startsWith(PREFIX)) return url;
  const v = versionOf(path.join(PUBLIC_DIR, url.slice(PREFIX.length)));
  return v === null ? url : `${url}?v=${v}`;
}

/** 靜態檔回應的 cache-control：請求帶的版本跟檔案現在的一樣才長期快取。 */
export function staticCacheControl(requestUrl: string | undefined, file: string): string {
  const asked = new URLSearchParams((requestUrl ?? '').split('?')[1] ?? '').get('v');
  return asked !== null && asked === versionOf(file) ? IMMUTABLE : 'no-cache';
}
