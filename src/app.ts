import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fstatic from '@fastify/static';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { countCardFiles } from './store/files.ts';
import { CardIndex } from './store/index/index.ts';
import { GitBackup, ensureCorpusRepo } from './store/backup.ts';
import { PUBLIC_DIR } from './web/render.ts';
import { registerRoutes } from './web/routes.ts';

/** 組裝根：把設定、索引、備份、路由接在一起，其他什麼都不做。 */

export interface AppOptions {
  config?: Config;
  logger?: unknown;
  gitRetryIntervalMs?: number;
}

export interface App {
  fastify: FastifyInstance;
  index: CardIndex;
  git: GitBackup;
  config: Config;
}

export function createApp(opts: AppOptions = {}): App {
  const config = opts.config ?? loadConfig();
  ensureCorpusRepo(config.corpusPath);

  const fastify = Fastify({ logger: (opts.logger ?? true) as never });
  fastify.register(formbody);
  // style.css 與那幾支 js 是直接從 public/ 讀的，改完不需要重新建置。
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
      `索引重建：${report.indexed}/${report.files} 筆，失敗 ${report.failures.length}，壞連結 ${report.bad_links.length}`,
    );
  }

  const git = new GitBackup({
    corpusPath: config.corpusPath,
    authorName: config.gitAuthorName,
    authorEmail: config.gitAuthorEmail,
    logger: fastify.log,
    retryIntervalMs: opts.gitRetryIntervalMs,
  });
  git.start();

  registerRoutes(fastify, index, git, config);

  fastify.addHook('onClose', async () => {
    git.stop();
    index.close();
  });

  return { fastify, index, git, config };
}
