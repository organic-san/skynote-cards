import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { DEFAULT_EDIT_WINDOW_HOURS } from '../src/domain/rules.ts';
import type { CorpusStore } from '../src/store/remote.ts';
import type { IapVerifier } from '../src/web/iap.ts';

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
  /** 反芻期長度。想測「窗口關了」的行為就把它調短。 */
  editWindowMs?: number;
  /** 遠端存放處（App Engine 的 bucket）。沒給就是本機檔案為真相。 */
  store?: CorpusStore;
  iap?: IapVerifier;
}): Promise<Harness & { dir: string }> {
  const logs: string[] = [];
  const app = createApp({
    config: {
      corpusPath: ws.corpus,
      indexPath: ws.indexPath,
      port: 0,
      host: '127.0.0.1',
      gitAuthorName: 'test',
      gitAuthorEmail: 'test@localhost',
      editWindowMs: ws.editWindowMs ?? DEFAULT_EDIT_WINDOW_HOURS * 60 * 60 * 1000,
      cloud: null,
      requireIap: false,
    },
    store: ws.store,
    iap: ws.iap,
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
  source_author?: string | null;
  source_date?: string | null;
  links?: { rel: string; to: string }[];
}

/**
 * R11：thinking 至少要有一個標籤。多數測試在意的不是標籤，所以沒帶的時候
 * 補這一個；要測標籤本身的測試會自己帶（帶空陣列就是真的沒有標籤）。
 */
export const DEFAULT_THINKING_TAG = '測試';

/**
 * R16：資料的內文必填（v3.3 §6）。理由同上：多數測試在意的不是內文，沒帶的時候補這一段；
 * 要測內文本身的測試會自己帶（帶空字串就是真的沒有內文）。
 */
export const DEFAULT_ORIGINAL_BODY = '原文';

export async function postCard(h: Harness, payload: NewCardPayload) {
  let sent: NewCardPayload = payload;
  if (payload.type === 'thinking' && payload.tags === undefined) {
    sent = { ...sent, tags: [DEFAULT_THINKING_TAG] };
  }
  if (payload.type === 'original' && payload.body === undefined) {
    sent = { ...sent, body: DEFAULT_ORIGINAL_BODY };
  }
  const res = await h.app.fastify.inject({
    method: 'POST',
    url: '/new',
    payload: sent,
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
