import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../src/app.ts';

/** 每個測試自己一個暫存語料庫與索引，彼此不共用狀態。 */

export interface Harness {
  app: App;
  dir: string;
  corpus: string;
  indexPath: string;
  logs: string[];
  close: () => Promise<void>;
}

export function makeWorkspace(): { dir: string; corpus: string; indexPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-'));
  const corpus = path.join(dir, 'corpus');
  fs.mkdirSync(path.join(corpus, 'cards'), { recursive: true });
  return { dir, corpus, indexPath: path.join(dir, 'index.db') };
}

export function gitInit(corpus: string, remote?: string): void {
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', corpus, ...args], { stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) run('remote', 'add', 'origin', remote);
}

export async function start(ws: {
  corpus: string;
  indexPath: string;
}): Promise<Harness & { dir: string }> {
  const logs: string[] = [];
  const app = createApp({
    config: {
      corpusPath: ws.corpus,
      indexPath: ws.indexPath,
      port: 0,
      gitAuthorName: 'test',
      gitAuthorEmail: 'test@localhost',
    },
    logger: {
      level: 'info',
      stream: {
        write(line: string) {
          logs.push(line);
        },
      },
    },
    gitRetryIntervalMs: 0,
  });
  await app.fastify.ready();
  return {
    app,
    dir: path.dirname(ws.indexPath),
    corpus: ws.corpus,
    indexPath: ws.indexPath,
    logs,
    close: async () => {
      await app.git.drain();
      await app.fastify.close();
    },
  };
}

export interface NewCardPayload {
  type: string;
  title: string;
  body?: string;
  tags?: string[] | string;
  url?: string | null;
  provenance?: string | null;
  links?: { rel: string; to: string }[];
}

export async function postCard(h: Harness, payload: NewCardPayload) {
  const res = await h.app.fastify.inject({
    method: 'POST',
    url: '/new',
    payload,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
  return res;
}

/** 建立成功時回傳新卡片的 ID，失敗直接讓測試爆掉。 */
export async function createCard(h: Harness, payload: NewCardPayload): Promise<string> {
  const res = await postCard(h, payload);
  if (res.statusCode !== 302) {
    throw new Error(`建立卡片失敗 ${res.statusCode}: ${res.body}`);
  }
  return (res.json() as { id: string }).id;
}

export function countCards(corpus: string): number {
  return fs.readdirSync(path.join(corpus, 'cards')).filter((f) => f.endsWith('.md')).length;
}
