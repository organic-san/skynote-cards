import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * public/ 底下的 CSS 與 JS 怎麼交給頁面。
 *
 * 起因是換頁時的閃爍。Ferdium 這類把網頁包在 Electron `<webview>` 裡的外殼，
 * 沒有一般分頁「舊畫面留到新頁畫好為止」的保護（paint holding）：新頁一接手，
 * 舊畫面就沒了，到新頁畫出第一格之前，看到的是外殼自己的底色（深色模式下是一塊黑）。
 * 新頁要等 CSS 才畫得出來，每一個 CSS 請求都是那一格黑的長度。
 *
 * **CSS 直接嵌進頁面**（`inlineCss`）。原本的想法是讓 CSS 長期快取，但正式環境的
 * IAP 會把每一個回應的快取標頭蓋成 `no-cache, must-revalidate`（外加 `pragma: no-cache`
 * 與 1990 年的 `expires`），瀏覽器每換一頁還是得回來驗證——隔著 IAP 的那一來一回，
 * 就是看得見的一閃。嵌進 HTML 就沒有那個請求：頁面一到就畫得出來。代價是每一頁
 * 多帶 CSS（去掉註解約 33KB，壓縮後約 6KB）。去註解、依修改時間快取，開發時改完存檔，
 * 下一頁就是新的。
 *
 * **JS 照舊另外載入**，網址帶著內容的版本（`assetUrl`）。它們是 defer 的，不擋第一格，
 * 在 IAP 後面每次回來驗證也不會閃；版本讓沒有 IAP 的部署（本機、VM）可以長期快取，
 * 又不會換來「改了卻看到舊版」（app.ts 那段 no-cache 的理由）：
 *
 * - 網址帶 `?v={內容的雜湊}`，檔案一改，網址就跟著換。
 * - 只有 `v` 等於這台機器上那個檔案現在的版本，才給一年的 immutable 快取。
 *   不帶 `v`、或帶的是別的版本（部署時舊機器接到新頁面發出的請求），照舊 no-cache——
 *   舊內容不會被記在新網址底下一年。
 * - 版本依修改時間與大小快取，變了才重算。
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

interface Inlined {
  mtimeMs: number;
  size: number;
  text: string;
}
const inlined = new Map<string, Inlined>();

/**
 * 模板用：一支 CSS 的內容，去掉註解，放進 `<style>`（`<%~ it.inlineCss('/static/css/base.css') %>`）。
 * 內容裡萬一有 `</style`，換成 CSS 的跳脫寫法，不會提早關掉那個元素。
 */
export function inlineCss(url: string): string {
  const file = path.join(PUBLIC_DIR, url.slice(PREFIX.length));
  const stat = fs.statSync(file);
  const hit = inlined.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<\/style/gi, '<\\/style');
  inlined.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
}

/** 靜態檔回應的 cache-control：請求帶的版本跟檔案現在的一樣才長期快取。 */
export function staticCacheControl(requestUrl: string | undefined, file: string): string {
  const asked = new URLSearchParams((requestUrl ?? '').split('?')[1] ?? '').get('v');
  return asked !== null && asked === versionOf(file) ? IMMUTABLE : 'no-cache';
}
