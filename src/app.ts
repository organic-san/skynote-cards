import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fstatic from '@fastify/static';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { countCardFiles } from './store/files.ts';
import { CardIndex } from './store/index/index.ts';
import { GitBackup, ensureCorpusRepo } from './store/backup.ts';
import { NO_STORE, type CorpusStore } from './store/remote.ts';
import { updateCorpus, type UpdateOutcome } from './service/update.ts';
import { IAP_HEADER, type IapVerifier } from './web/iap.ts';
import { PUBLIC_DIR } from './web/render.ts';
import { WARMUP_PATH, registerRoutes } from './web/routes.ts';

/** 組裝根：把設定、索引、備份、路由接在一起，其他什麼都不做。 */

export interface AppOptions {
  config?: Config;
  logger?: unknown;
  gitRetryIntervalMs?: number;
  /** 遠端存放處。沒給就是 NO_STORE：本機檔案是真相。 */
  store?: CorpusStore;
  /** 給了就要求每個請求帶 IAP 的 JWT（見 web/iap.ts）。 */
  iap?: IapVerifier;
  /**
   * 開機後多久再跟遠端對帳一次（毫秒），0 不排。
   * 部署時新舊兩版會重疊幾十秒：新版開機對帳之後、舊版停下之前，
   * 舊版收到的寫入新版看不到。等舊版停了再對一次就接得住。
   */
  resyncAfterMs?: number;
}

export interface App {
  fastify: FastifyInstance;
  index: CardIndex;
  git: GitBackup;
  config: Config;
  store: CorpusStore;
}

/** push 被拒絕而自動取回，兩次之間至少隔這麼久，不讓一個推不上去的狀態變成迴圈。 */
const AUTO_SYNC_MIN_MS = 5 * 60 * 1000;

export function createApp(opts: AppOptions = {}): App {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? NO_STORE;
  ensureCorpusRepo(config.corpusPath);

  const fastify = Fastify({ logger: (opts.logger ?? true) as never });

  // 最先掛：靜態檔、404 都要經過它。只放過 App Engine 自己打的 warmup，
  // 它不經過 IAP、也不回任何資料；其他路徑一律要驗。
  const iap = opts.iap;
  if (iap) {
    fastify.addHook('onRequest', async (req, reply) => {
      if (req.url.split('?')[0] === WARMUP_PATH) return;
      const token = req.headers[IAP_HEADER];
      if (await iap(typeof token === 'string' ? token : undefined)) return;
      return reply.code(403).type('text/plain; charset=utf-8').send('需要經過 Google 登入（IAP）。');
    });
  }

  fastify.register(formbody);
  // public/css/*.css 與那幾支 js 是直接從 public/ 讀的，改完不需要重新建置。
  // 但只要中間有任何一層（瀏覽器、Cloudflare 邊緣）把舊版留著，改了就看不到，
  // 而且症狀是「版面沒變」這種很難聯想到快取的樣子。
  // no-cache 不是不存，是每次都要回來驗證：沒變就回 304，幾乎不花流量，
  // 但永遠不會拿到舊的。
  fastify.register(fstatic, {
    root: PUBLIC_DIR,
    prefix: '/static/',
    cacheControl: false,
    setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
  });

  // 索引不存在，或索引筆數跟卡片檔案數對不上，就整個重建。
  const indexExisted = fs.existsSync(config.indexPath);
  const index = new CardIndex(config.indexPath, config.corpusPath);
  if (!indexExisted || index.countCards() !== countCardFiles(config.corpusPath)) {
    const report = index.rebuild();
    fastify.log.info(
      `索引重建：${report.indexed}/${report.files} 張，失敗 ${report.failures.length}，` +
        `壞連結 ${report.bad_links.length}，規則警告 ${report.warnings.length}`,
    );
  }

  // 自動取回只在有遠端存放處時做（見下面）。沒有的時候 push 被拒絕
  // 照舊等人按「更新」，行為跟以前一樣。
  let onPushRejected = (): void => {};
  const git = new GitBackup({
    corpusPath: config.corpusPath,
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    logger: fastify.log,
    retryIntervalMs: opts.gitRetryIntervalMs,
    onPushRejected: store.kind === 'none' ? undefined : () => onPushRejected(),
  });
  git.start();

  registerRoutes(fastify, index, git, config, store);

  /*
    有遠端存放處時，兩種情況自動跑一次「更新」（取回、對帳、補 commit、重建索引）：

    - 開機後 resyncAfterMs：部署時新舊兩版重疊的那段期間，舊版收到的寫入。
    - push 被拒絕（遠端比本機新）：別處推了東西，或另一台機器先推了。
      不取回的話這台的備份永遠推不上去，只能等人剛好按到「更新」。

    同一時間只跑一個；而且因為 push 失敗觸發的，兩次之間隔至少五分鐘。
  */
  let running: Promise<unknown> | null = null;
  let lastAuto = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  const autoSync = (why: string) => {
    if (running || Date.now() - lastAuto < AUTO_SYNC_MIN_MS) return;
    lastAuto = Date.now();
    running = updateCorpus({ corpusPath: config.corpusPath, git, index, store, logger: fastify.log })
      .then((o) => fastify.log.info(`自動更新（${why}）：${summarize(o)}`))
      .catch((err: unknown) =>
        fastify.log.error(`自動更新（${why}）失敗: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        running = null;
      });
  };
  if (store.kind !== 'none') {
    onPushRejected = () => autoSync('push 被拒絕');
    const after = opts.resyncAfterMs ?? 0;
    if (after > 0) {
      timer = setTimeout(() => autoSync('開機後'), after);
      timer.unref();
    }
  }

  fastify.addHook('onClose', async () => {
    if (timer) clearTimeout(timer);
    await running;
    git.stop();
    index.close();
  });

  return { fastify, index, git, config, store };
}

function summarize(o: UpdateOutcome): string {
  const parts = [`git ${o.pull.kind}`];
  if (o.pull.kind === 'pulled') parts.push(`取回 ${o.pull.commits.length} 個 commit`);
  if (o.store?.report) {
    const r = o.store.report;
    parts.push(
      `上傳 ${r.uploaded.length}、下載 ${r.downloaded.length}、刪除 ${r.deleted.length}、衝突 ${r.conflicts.length}`,
    );
  }
  if (o.store?.error) parts.push(`對帳失敗 ${o.store.error}`);
  if (o.reindex) parts.push(`索引 ${o.reindex.indexed}/${o.reindex.files}`);
  return parts.join('，');
}
