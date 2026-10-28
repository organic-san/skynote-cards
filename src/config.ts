import path from 'node:path';
import { DEFAULT_EDIT_WINDOW_HOURS } from './domain/rules.ts';

/** 執行時設定。全部有預設值，本機不必給環境變數就能跑起來。 */
export interface Config {
  corpusPath: string;
  indexPath: string;
  port: number;
  /**
   * 監聽的位址。預設只聽 localhost：VM 上由 Cloudflare Tunnel 接出去，
   * 機器不開任何對外埠。App Engine 要聽 0.0.0.0，前端才接得到（見 app.yaml）。
   */
  host: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** 反芻期長度，毫秒（R5）。小時進、毫秒出，只在這裡換算一次。 */
  editWindowMs: number;
  /** App Engine 的設定。null = 本機檔案就是真相（本機開發、測試、VM）。 */
  cloud: CloudConfig | null;
  /**
   * 每個請求都要帶 IAP 簽的 JWT，沒有就 403（見 web/iap.ts）。
   * 只看前面那層擋人是不夠的：IAP 被關掉的那一刻，這支沒有登入的程式就整個對外了。
   */
  requireIap: boolean;
}

export interface CloudConfig {
  /** 卡片的 Cloud Storage bucket，它是唯一真相。 */
  bucket: string;
  /** 語料庫的 git remote（HTTPS）。開機時 clone 它，之後推備份。null = 不備份。 */
  remote: string | null;
  /** 推 remote 用的 token 放在 Secret Manager 的哪個 secret（同一個專案）。 */
  tokenSecret: string | null;
  /** 直接給 token（本機試跑用）。有它就不去讀 secret。 */
  token: string | null;
  /** GCP 專案 ID。App Engine 會自己設 GOOGLE_CLOUD_PROJECT。 */
  project: string | null;
}

/**
 * 亂填的值退回預設，不讓它變成 NaN。
 * NaN 會讓每一張卡都「已過期」——一個設定的手誤靜悄悄關掉整個反芻期，
 * 而畫面上只會看到「編輯」按鈕不見了。
 */
function editWindowHours(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EDIT_WINDOW_HOURS;
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function flag(v: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());
}

/**
 * CORPUS_BUCKET 可以寫成 `{project}-corpus`，`{project}` 換成專案 ID。
 * app.yaml 因此不必寫死任何一個專案的名字。
 * 寫了 `{project}` 卻不知道專案 ID 就直接失敗——猜一個 bucket 名字比不能開機更糟。
 */
function cloudConfig(env: NodeJS.ProcessEnv): CloudConfig | null {
  const raw = nonEmpty(env.CORPUS_BUCKET);
  if (!raw) return null;
  const project = nonEmpty(env.GOOGLE_CLOUD_PROJECT);
  if (raw.includes('{project}') && !project) {
    throw new Error('CORPUS_BUCKET 用了 {project}，但沒有 GOOGLE_CLOUD_PROJECT');
  }
  return {
    bucket: project ? raw.replaceAll('{project}', project) : raw,
    remote: nonEmpty(env.CORPUS_REMOTE),
    tokenSecret: nonEmpty(env.CORPUS_GIT_TOKEN_SECRET),
    token: nonEmpty(env.CORPUS_GIT_TOKEN),
    project,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const corpusPath = path.resolve(env.CORPUS_PATH ?? './corpus-dev');
  return {
    corpusPath,
    // 索引放在語料庫 repo 外，不進版控。
    indexPath: path.resolve(env.INDEX_PATH ?? path.join(corpusPath, '..', 'index.db')),
    port: Number(env.PORT ?? 3000),
    host: nonEmpty(env.HOST) ?? '127.0.0.1',
    gitAuthorName: env.GIT_AUTHOR_NAME ?? 'append-cards',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? 'append-cards@localhost',
    editWindowMs: editWindowHours(env.EDIT_WINDOW_HOURS) * 60 * 60 * 1000,
    cloud: cloudConfig(env),
    requireIap: flag(env.REQUIRE_IAP),
  };
}
