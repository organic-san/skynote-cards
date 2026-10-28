import { createApp } from './app.ts';
import { consoleLogger, prepareCloud, resolveIapAudience } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { createIapVerifier } from './web/iap.ts';

/**
 * 行程進入點。
 *
 * VM 與本機：只監聽 localhost，由 Cloudflare Tunnel 接出去（HOST 預設 127.0.0.1）。
 * App Engine：先把語料庫準備好（clone、跟 bucket 對帳，見 bootstrap.ts）才開始接請求，
 * 而且每個請求都要經過 IAP 驗證。
 */

/** App Engine 停機器時只給兩秒左右的收尾時間。 */
const SHUTDOWN_GRACE_MS = 1500;
/** 開機後多久再跟 bucket 對一次帳（部署時新舊兩版重疊的那段，見 app.ts）。 */
const RESYNC_AFTER_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const boot = config.cloud ? await prepareCloud(config, consoleLogger) : null;
  const iap = config.requireIap
    ? createIapVerifier({ audience: await resolveIapAudience() })
    : undefined;

  const { fastify, git } = createApp({
    config,
    store: boot?.store,
    iap,
    resyncAfterMs: boot ? RESYNC_AFTER_MS : 0,
  });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      // 卡片本身已經存好了（有 bucket 時在 bucket，沒有時在本機檔案）。
      // 這裡只是讓還在佇列裡的 commit 與 push 有機會做完，做不完下次開機會補。
      void Promise.race([git.drain(), sleep(SHUTDOWN_GRACE_MS)])
        .then(() => fastify.close())
        .finally(() => process.exit(0));
    });
  }

  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(
    `corpus=${config.corpusPath} index=${config.indexPath} store=${boot?.store.label ?? 'none'}` +
      ` iap=${iap ? 'required' : 'off'}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

main().catch((err: unknown) => {
  // 開機失敗就讓行程結束：App Engine 會換一台重來，日誌裡留著原因。
  console.error(`開機失敗: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
