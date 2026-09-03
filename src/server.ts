import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

/** 行程進入點。對外只監聽 localhost，由 Cloudflare Tunnel 接出去。 */

const config = loadConfig();
const { fastify } = createApp({ config });

async function main(): Promise<void> {
  await fastify.listen({ port: config.port, host: '127.0.0.1' });
  fastify.log.info(`corpus=${config.corpusPath} index=${config.indexPath}`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void fastify.close().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  fastify.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
