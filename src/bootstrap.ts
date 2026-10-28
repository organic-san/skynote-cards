import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { CloudConfig, Config } from './config.ts';
import {
  GcsStore,
  accessSecret,
  metadataTokenSource,
  metadataValue,
  type FetchLike,
  type TokenSource,
} from './store/gcs.ts';
import { gitObjects, reconcile, type ReconcileReport } from './store/reconcile.ts';
import type { CorpusStore } from './store/remote.ts';

/**
 * App Engine 上開機時要先做的事，全部在開始接請求之前做完：
 *
 * 1. 拿 GitHub token（Secret Manager），設定成只對那個 remote 生效。
 * 2. clone 語料庫到 /tmp（每台新機器的 /tmp 都是空的）。
 * 3. 跟 bucket 對帳（store/reconcile.ts）：bucket 上還沒推上去的寫入寫進本機，
 *    git 那邊較新的修改傳上 bucket。bucket 是空的（第一次部署）就整批傳上去。
 *
 * 之後 createApp 重建索引、補 commit 並 push。
 *
 * GitHub 連不上時不擋開機：bucket 裡有全部的卡，只用它開機，
 * git 備份停用到下次換機器為止（/_health 的 git.enabled 會是 false）。
 * 讀寫不經過 GitHub，GitHub 掛了不該讓整個服務起不來。
 */

export interface BootLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: BootLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

const CLONE_TIMEOUT_MS = 60_000;

export interface CloudBoot {
  store: CorpusStore;
  report: ReconcileReport;
  git: 'cloned' | 'existing' | 'unavailable' | 'disabled';
}

/** 正式環境的組裝：真的 bucket、metadata server 的 token。 */
export async function prepareCloud(config: Config, logger: BootLogger): Promise<CloudBoot> {
  const cloud = config.cloud;
  if (!cloud) throw new Error('沒有雲端設定（CORPUS_BUCKET）');
  const token = metadataTokenSource();
  const store = new GcsStore({ bucket: cloud.bucket, token });
  const gitToken = await resolveGitToken(cloud, token, logger);
  return prepareCorpus({ corpusPath: config.corpusPath, cloud, store, gitToken, logger });
}

export async function prepareCorpus(opts: {
  corpusPath: string;
  cloud: CloudConfig;
  store: CorpusStore;
  gitToken: string | null;
  logger: BootLogger;
}): Promise<CloudBoot> {
  const { corpusPath, cloud, store, logger } = opts;
  process.env.GIT_TERMINAL_PROMPT = '0';

  let git: CloudBoot['git'] = 'disabled';
  if (cloud.remote) {
    if (opts.gitToken) useGitToken(cloud.remote, opts.gitToken);
    if (fs.existsSync(path.join(corpusPath, '.git'))) {
      git = 'existing';
    } else {
      try {
        fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
        await simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } }).clone(cloud.remote, corpusPath);
        git = 'cloned';
      } catch (err) {
        git = 'unavailable';
        logger.error(
          `clone 語料庫失敗，這台機器只用 bucket 開機、不做 git 備份: ${errText(err)}`,
        );
      }
    }
  }
  fs.mkdirSync(path.join(corpusPath, 'cards'), { recursive: true });

  const started = Date.now();
  const report = await reconcile({
    corpusPath,
    store,
    history: await gitObjects(corpusPath),
    logger,
  });
  logger.info(
    `開機對帳（${store.label}，git ${git}，${Date.now() - started}ms）：` +
      `上傳 ${report.uploaded.length}、下載 ${report.downloaded.length}、` +
      `刪除 ${report.deleted.length}、衝突 ${report.conflicts.length}` +
      (report.deletionsSkipped.length ? `、略過刪除 ${report.deletionsSkipped.length}` : ''),
  );
  return { store, report, git };
}

/** 推語料庫用的 token：直接給的優先，否則讀 Secret Manager。拿不到不擋開機。 */
async function resolveGitToken(
  cloud: CloudConfig,
  token: TokenSource,
  logger: BootLogger,
): Promise<string | null> {
  if (cloud.token) return cloud.token;
  if (!cloud.tokenSecret) return null;
  if (!cloud.project) {
    logger.error('有 CORPUS_GIT_TOKEN_SECRET 卻不知道專案 ID（GOOGLE_CLOUD_PROJECT），不讀 secret');
    return null;
  }
  try {
    return await accessSecret(cloud.project, cloud.tokenSecret, token);
  } catch (err) {
    logger.error(`讀不到 GitHub token，clone 與 push 可能會失敗: ${errText(err)}`);
    return null;
  }
}

/**
 * 讓這個行程裡的每一次 git 都帶著 token 連 remote 那台主機，不寫進任何檔案。
 *
 * 用 GIT_CONFIG_COUNT 這組環境變數（git 2.31 起）加一條 http.<host>/.extraheader，
 * 跟 actions/checkout 的做法相同。token 不進 remote 網址：git 的錯誤訊息會印網址，
 * 那些訊息會進日誌。
 */
export function useGitToken(remote: string, token: string, env: NodeJS.ProcessEnv = process.env): void {
  const origin = new URL(remote).origin;
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = `http.${origin}/.extraheader`;
  env[`GIT_CONFIG_VALUE_${n}`] =
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/**
 * IAP JWT 的 audience。App Engine 是 `/projects/<專案編號>/apps/<專案 ID>`，
 * 專案編號只有 metadata server 知道。`IAP_AUDIENCE` 可以直接指定（本機試跑用）。
 * 拿不到就丟錯，讓開機失敗——要求 IAP 卻驗不了，不能變成不驗。
 */
export async function resolveIapAudience(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const fixed = env.IAP_AUDIENCE?.trim();
  if (fixed) return fixed;
  const number = await metadataValue('project/numeric-project-id', fetchImpl);
  const id = env.GOOGLE_CLOUD_PROJECT?.trim() || (await metadataValue('project/project-id', fetchImpl));
  return `/projects/${number}/apps/${id}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
