import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { prepareCorpus, resolveIapAudience, useGitToken } from '../src/bootstrap.ts';
import { loadConfig, type CloudConfig } from '../src/config.ts';
import { serializeCard } from '../src/domain/card.ts';
import { STORE_UNAVAILABLE_MESSAGE } from '../src/service/cards.ts';
import { GcsStore, HttpError } from '../src/store/gcs.ts';
import { gitObjects, reconcile } from '../src/store/reconcile.ts';
import {
  NO_BASE,
  StoreConflictError,
  blobHash,
  md5Base64,
  type CorpusStore,
  type PutOptions,
  type StoredObject,
} from '../src/store/remote.ts';
import { createIapVerifier } from '../src/web/iap.ts';
import { createCard, gitInit, makeWorkspace, postCard, start, type Harness } from './helpers.ts';

/** App Engine 架構：bucket 是真相、/tmp 是副本、GitHub 是備份（deploy/README.md）。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 測試用的 bucket

/** 記憶體裡的 bucket。`down` 打開就每個動作都失敗；`delayMs` 讓上傳慢一點。 */
class FakeStore implements CorpusStore {
  readonly kind = 'gcs' as const;
  readonly label = 'gs://fake';
  readonly objects = new Map<string, { content: Buffer; blob: string | null; base: string | null }>();
  readonly puts: { name: string; opts: PutOptions }[] = [];
  down = false;
  delayMs = 0;

  private check(): void {
    if (this.down) throw new Error('bucket 掛了');
  }
  async list(): Promise<StoredObject[]> {
    this.check();
    return [...this.objects].map(([name, o]) => ({
      name,
      md5: md5Base64(o.content),
      blob: o.blob,
      base: o.base,
    }));
  }
  async get(name: string): Promise<Buffer> {
    this.check();
    const o = this.objects.get(name);
    if (!o) throw new Error(`404 ${name}`);
    return o.content;
  }
  async put(name: string, content: Buffer | string, opts: PutOptions): Promise<void> {
    if (this.delayMs) await sleep(this.delayMs);
    this.check();
    if (opts.ifGenerationMatch === 0 && this.objects.has(name)) throw new StoreConflictError(name);
    this.objects.set(name, { content: Buffer.from(content), blob: opts.blob, base: opts.base });
    this.puts.push({ name, opts });
  }
  async delete(name: string): Promise<void> {
    this.check();
    this.objects.delete(name);
  }

  /** 放一個物件進去。meta 不給就是「從主控台放進去的」，沒有 metadata。 */
  seed(name: string, content: string, meta?: { blob: string; base: string }): void {
    this.objects.set(name, {
      content: Buffer.from(content),
      blob: meta?.blob ?? null,
      base: meta?.base ?? null,
    });
  }
  /** 當成 git 那份的副本放進去（本程式上傳 git 的版本時就是這個樣子）。 */
  seedMirror(name: string, content: string): void {
    this.seed(name, content, { blob: blobHash(content), base: blobHash(content) });
  }
  text(name: string): string | undefined {
    return this.objects.get(name)?.content.toString('utf8');
  }
}

// ---------------------------------------------------------------- 小工具

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'pipe',
  }).toString();
}

/** 一張合法的卡片檔內容。 */
function cardText(id: string, title: string, body = ''): string {
  return serializeCard({
    id,
    type: 'original',
    created: '2026-09-03T00:00:00.000Z',
    title,
    tags: [],
    url: null,
    provenance: 'default',
    source_author: null,
    source_date: null,
    revised: null,
    links: [],
    body,
  });
}

const A = '88800000000000010';
const B = '88800000000000011';
const C = '88800000000000012';
const obj = (id: string) => `cards/${id}.md`;

function writeLocal(corpus: string, id: string, text: string): void {
  fs.mkdirSync(path.join(corpus, 'cards'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'cards', `${id}.md`), text);
}
function readLocal(corpus: string, id: string): string | null {
  const p = path.join(corpus, 'cards', `${id}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function quietLogger() {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  };
}

/** 一個有 git 的語料庫。每一組卡片一個 commit，照順序。 */
function repo(...commits: Record<string, string | null>[]): string {
  const ws = makeWorkspace();
  gitInit(ws.corpus);
  commits.forEach((files, i) => {
    for (const [id, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(ws.corpus, 'cards', `${id}.md`));
      else writeLocal(ws.corpus, id, text);
    }
    git(ws.corpus, 'add', '-A', 'cards');
    git(ws.corpus, 'commit', '-q', '-m', `c${i}`);
  });
  return ws.corpus;
}

async function runReconcile(corpus: string, store: FakeStore, logger = quietLogger()) {
  return reconcile({ corpusPath: corpus, store, history: await gitObjects(corpus), logger });
}

async function withStore(store: FakeStore, opts: { git?: boolean } = {}): Promise<Harness> {
  const ws = makeWorkspace();
  if (opts.git) gitInit(ws.corpus);
  const h = await start({ ...ws, store });
  cleanups.push(h.close);
  return h;
}

async function json(h: Harness, method: 'PUT' | 'DELETE' | 'POST', url: string, payload?: object) {
  // 沒有 body 就不能宣稱是 JSON：Fastify 會先回 400。
  return h.app.fastify.inject({
    method,
    url,
    payload,
    headers: payload
      ? { 'content-type': 'application/json', accept: 'application/json' }
      : { accept: 'application/json' },
  });
}

// ---------------------------------------------------------------- 寫入路徑

describe('寫入：先存進 bucket，成功了才算數', () => {
  test('建立：內容進 bucket，要求物件還不存在，base 是 none', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    const id = await createCard(h, { type: 'original', title: '一份資料', body: '內文' });

    const file = readLocal(h.corpus, id);
    assert.ok(file);
    assert.equal(store.text(obj(id)), file, 'bucket 與本機副本逐字相同');
    const put = store.puts.find((p) => p.name === obj(id));
    assert.equal(put?.opts.ifGenerationMatch, 0);
    assert.equal(put?.opts.base, NO_BASE);
    assert.equal(put?.opts.blob, blobHash(file));
  });

  test('bucket 存不進去：503，檔案、索引、commit 都沒有，表單照樣重繪', async () => {
    const store = new FakeStore();
    const h = await withStore(store, { git: true });
    store.down = true;

    const res = await postCard(h, { type: 'original', title: '存不進去' });
    assert.equal(res.statusCode, 503);
    assert.ok(res.body.includes(STORE_UNAVAILABLE_MESSAGE));
    assert.equal(fs.readdirSync(path.join(h.corpus, 'cards')).length, 0);
    assert.equal(h.app.index.countCards(), 0);
    await h.app.git.drain();
    assert.equal(git(h.corpus, 'rev-list', '--count', 'HEAD').trim(), '1', '只有 init');

    // 瀏覽器送的表單：同一張表單退回來，沒有 302，草稿不會被清。
    const form = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: 'type=original&title=%E5%AD%98%E4%B8%8D%E9%80%B2%E5%8E%BB&draft_scope=new',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.statusCode, 503);
    assert.ok(form.body.includes('<form'));
    assert.ok(form.body.includes('存不進去'), '打的字還在表單裡');
  });

  test('隨手記存不進去也是 503', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    store.down = true;
    const res = await json(h, 'POST', '/quick', { body: '一句話' });
    assert.equal(res.statusCode, 503);
    assert.equal(h.app.index.countCards(), 0);
  });

  test('修改：base 是改之前那一份；存不進去就 503、檔案不變', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    const id = await createCard(h, { type: 'original', title: '原本', body: '一' });
    const before = readLocal(h.corpus, id) ?? '';

    const ok = await json(h, 'PUT', `/c/${id}`, { body: '二' });
    assert.equal(ok.statusCode, 200);
    const after = readLocal(h.corpus, id) ?? '';
    const put = store.puts.at(-1);
    assert.equal(put?.opts.base, blobHash(before));
    assert.equal(put?.opts.blob, blobHash(after));
    assert.equal(put?.opts.ifGenerationMatch, undefined, '修改不要求物件不存在');
    assert.equal(store.text(obj(id)), after);

    store.down = true;
    const fail = await json(h, 'PUT', `/c/${id}`, { body: '三' });
    assert.equal(fail.statusCode, 503);
    assert.equal(readLocal(h.corpus, id), after);
    assert.ok(h.app.index.getCard(id)?.body.includes('二'));
  });

  test('刪除：先刪 bucket；刪不掉就什麼都不動', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    const id = await createCard(h, { type: 'original', title: '要刪的' });

    store.down = true;
    const fail = await json(h, 'DELETE', `/c/${id}`);
    assert.equal(fail.statusCode, 503);
    assert.ok(readLocal(h.corpus, id));
    assert.ok(h.app.index.getCard(id));

    store.down = false;
    const ok = await json(h, 'DELETE', `/c/${id}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(store.objects.has(obj(id)), false);
    assert.equal(readLocal(h.corpus, id), null);
  });

  test('勾選也經過 bucket', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    const id = await createCard(h, { type: 'original', title: '待辦', body: '- [ ] 一件事' });
    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    const rev = /class="body"[^>]*data-rev="([0-9a-f]+)"/.exec(page)?.[1] ?? '';

    const res = await json(h, 'POST', `/c/${id}/tasks/0`, { checked: true, rev });
    assert.equal(res.statusCode, 200);
    assert.ok(store.text(obj(id))?.includes('- [x] 一件事'));
  });

  test('同一張卡同時兩個修改：寫入鎖讓 rev 比對照樣有效，後到的 409', async () => {
    const store = new FakeStore();
    const h = await withStore(store);
    const id = await createCard(h, { type: 'original', title: '同時改', body: '原文' });
    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    const rev = /class="body"[^>]*data-rev="([0-9a-f]+)"/.exec(page)?.[1] ?? '';

    // 上傳慢一點：沒有鎖的話，兩個請求都會在對方寫進去之前通過 rev 比對。
    store.delayMs = 30;
    const [a, b] = await Promise.all([
      json(h, 'PUT', `/c/${id}`, { body: '甲', rev }),
      json(h, 'PUT', `/c/${id}`, { body: '乙', rev }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  });

  test('/_health 說得出真相在哪裡', async () => {
    const plain = await start(makeWorkspace());
    cleanups.push(plain.close);
    assert.equal((await plain.app.fastify.inject('/_health')).json().store, 'none');
    const h = await withStore(new FakeStore());
    assert.equal((await h.app.fastify.inject('/_health')).json().store, 'gs://fake');
  });
});

// ---------------------------------------------------------------- 對帳

describe('對帳：bucket 與 git 誰比較新', () => {
  test('bucket 是空的（第一次部署）：git 的卡全部傳上去，標成副本', async () => {
    const corpus = repo({ [A]: cardText(A, 'a'), [B]: cardText(B, 'b') });
    const store = new FakeStore();
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.uploaded, [obj(A), obj(B)]);
    const o = store.objects.get(obj(A));
    assert.equal(o?.blob, blobHash(cardText(A, 'a')));
    assert.equal(o?.base, o?.blob, '副本：base == blob');
  });

  test('內容相同就不動', async () => {
    const corpus = repo({ [A]: cardText(A, 'a') });
    const store = new FakeStore();
    store.seed(obj(A), cardText(A, 'a'), { blob: 'x', base: 'y' });
    const r = await runReconcile(corpus, store);
    assert.deepEqual([r.uploaded, r.downloaded, r.deleted], [[], [], []]);
  });

  test('bucket 上是在本機這份之上的寫入（還沒推上去）：寫進本機', async () => {
    const v1 = cardText(A, 'v1');
    const v2 = cardText(A, 'v2');
    const corpus = repo({ [A]: v1 });
    const store = new FakeStore();
    store.seed(obj(A), v2, { blob: blobHash(v2), base: blobHash(v1) });
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.downloaded, [obj(A)]);
    assert.equal(readLocal(corpus, A), v2);
  });

  test('git 往前走了（別處改過推上來），bucket 還是舊的副本：以 git 為準', async () => {
    const v1 = cardText(A, 'v1');
    const v2 = cardText(A, 'v2');
    const corpus = repo({ [A]: v1 }, { [A]: v2 });
    const store = new FakeStore();
    store.seedMirror(obj(A), v1);
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.uploaded, [obj(A)]);
    assert.equal(store.text(obj(A)), v2);
    assert.equal(readLocal(corpus, A), v2);
  });

  test('網頁寫過、已經推上去，之後 git 又被別處改了：以 git 為準', async () => {
    const v1 = cardText(A, 'v1');
    const v2 = cardText(A, 'v2');
    const v3 = cardText(A, 'v3');
    const corpus = repo({ [A]: v1 }, { [A]: v2 }, { [A]: v3 });
    const store = new FakeStore();
    // v2 是網頁上的修改（改自 v1），後來 commit 了；v3 是別處的修改。
    store.seed(obj(A), v2, { blob: blobHash(v2), base: blobHash(v1) });
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.uploaded, [obj(A)]);
    assert.equal(store.text(obj(A)), v3);
  });

  test('只有 bucket 有的新卡（還沒推上去）：寫進本機', async () => {
    const corpus = repo({ [A]: cardText(A, 'a') });
    const store = new FakeStore();
    store.seedMirror(obj(A), cardText(A, 'a'));
    store.seed(obj(B), cardText(B, 'new'), { blob: blobHash(cardText(B, 'new')), base: NO_BASE });
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.downloaded, [obj(B)]);
    assert.equal(readLocal(corpus, B), cardText(B, 'new'));
  });

  test('只有 bucket 有、而且是 git 那份的副本：git 那邊刪了，bucket 也刪', async () => {
    const corpus = repo({ [A]: cardText(A, 'a'), [B]: cardText(B, 'b') }, { [B]: null });
    const store = new FakeStore();
    store.seedMirror(obj(A), cardText(A, 'a'));
    store.seedMirror(obj(B), cardText(B, 'b'));
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.deleted, [obj(B)]);
    assert.equal(store.objects.has(obj(B)), false);
  });

  test('改回以前的內容（勾了又取消）仍然是新的寫入，不被當成舊的', async () => {
    const v1 = cardText(A, 't', '- [ ] x');
    const v2 = cardText(A, 't', '- [x] x');
    // v2（勾起來）推上去了；之後在網頁上取消勾選，內容又變回 v1——它在歷史裡。
    const corpus = repo({ [A]: v1 }, { [A]: v2 });
    const store = new FakeStore();
    store.seed(obj(A), v1, { blob: blobHash(v1), base: blobHash(v2) });
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.downloaded, [obj(A)]);
    assert.equal(readLocal(corpus, A), v1);
  });

  test('沒有 metadata 的物件：內容在歷史裡就以 git 為準，不在就取回', async () => {
    const v1 = cardText(A, 'v1');
    const v2 = cardText(A, 'v2');
    const corpus = repo({ [A]: v1 }, { [A]: v2 });
    const store = new FakeStore();
    store.seed(obj(A), v1);
    store.seed(obj(B), cardText(B, '主控台放進來的'));
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.uploaded, [obj(A)]);
    assert.deepEqual(r.downloaded, [obj(B)]);
  });

  test('兩邊都改了：以 bucket 為準，列為衝突，git 那份留在歷史裡', async () => {
    const v1 = cardText(A, 'v1');
    const v2 = cardText(A, 'git 這邊');
    const v3 = cardText(A, '網頁這邊');
    const corpus = repo({ [A]: v1 }, { [A]: v2 });
    const store = new FakeStore();
    store.seed(obj(A), v3, { blob: blobHash(v3), base: blobHash(v1) });
    const log = quietLogger();
    const r = await runReconcile(corpus, store, log);
    assert.deepEqual(r.downloaded, [obj(A)]);
    assert.deepEqual(r.conflicts, [obj(A)]);
    assert.equal(readLocal(corpus, A), v3);
    assert.equal(log.warns.length, 1);
  });

  test('只有本機有：傳上去（分不出是別處新增還是網頁刪掉時，選不會丟東西的那邊）', async () => {
    const corpus = repo({ [A]: cardText(A, 'a') });
    const store = new FakeStore();
    const r = await runReconcile(corpus, store);
    assert.deepEqual(r.uploaded, [obj(A)]);
  });

  test('沒有 git（clone 失敗）：一律以 bucket 為準，絕不刪 bucket 的東西', async () => {
    const ws = makeWorkspace();
    const store = new FakeStore();
    store.seedMirror(obj(A), cardText(A, 'a'));
    store.seed(obj(B), cardText(B, 'b'), { blob: blobHash(cardText(B, 'b')), base: NO_BASE });
    const r = await reconcile({
      corpusPath: ws.corpus,
      store,
      history: await gitObjects(ws.corpus),
      logger: quietLogger(),
    });
    assert.deepEqual(r.downloaded, [obj(A), obj(B)]);
    assert.deepEqual(r.deleted, []);
    assert.equal(store.objects.size, 2);
  });

  test('一次要刪很多（remote 設錯了？）：整批不刪，記一筆錯誤', async () => {
    const corpus = repo();
    const store = new FakeStore();
    for (let i = 0; i < 12; i += 1) {
      const id = String(88800000000000100n + BigInt(i));
      store.seedMirror(obj(id), cardText(id, `card ${i}`));
    }
    const log = quietLogger();
    const r = await runReconcile(corpus, store, log);
    assert.equal(r.deleted.length, 0);
    assert.equal(r.deletionsSkipped.length, 12);
    assert.equal(store.objects.size, 12);
    assert.equal(log.errors.length, 1);
  });
});

// ---------------------------------------------------------------- 開機、更新、自動取回

/** 一個 bare remote，加上「別處」的一份 clone（已經推過一個空的 init）。 */
function bareRemote(): { remote: string; other: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-cloud-'));
  const remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const other = path.join(dir, 'other');
  fs.mkdirSync(path.join(other, 'cards'), { recursive: true });
  gitInit(other, remote);
  git(other, 'push', '-q', '-u', 'origin', 'main');
  return { remote, other, dir };
}

function pushFromOther(other: string, id: string, text: string): void {
  writeLocal(other, id, text);
  git(other, 'add', '-A', 'cards');
  git(other, 'commit', '-q', '-m', `add ${id}`);
  git(other, 'push', '-q', 'origin', 'main');
}

const cloudOf = (remote: string | null): CloudConfig => ({
  bucket: 'fake',
  remote,
  tokenSecret: null,
  token: null,
  project: null,
});

/** 跟 App Engine 開機一樣：先準備語料庫，再起 app。 */
async function bootLikeAppEngine(remote: string | null, store: FakeStore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-boot-'));
  const corpus = path.join(dir, 'corpus');
  const boot = await prepareCorpus({
    corpusPath: corpus,
    cloud: cloudOf(remote),
    store,
    gitToken: null,
    logger: quietLogger(),
  });
  const h = await start({ corpus, indexPath: path.join(dir, 'index.db'), store });
  cleanups.push(h.close);
  await h.app.git.drain();
  return { boot, h };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等不到');
    await sleep(50);
  }
}

describe('開機與更新', () => {
  test('開機：clone、取回 bucket 上還沒推上去的卡、補 commit 推上去', async () => {
    const { remote, other } = bareRemote();
    pushFromOther(other, A, cardText(A, '推上去的'));
    const store = new FakeStore();
    store.seedMirror(obj(A), cardText(A, '推上去的'));
    store.seed(obj(B), cardText(B, '只在 bucket'), {
      blob: blobHash(cardText(B, '只在 bucket')),
      base: NO_BASE,
    });

    const { boot, h } = await bootLikeAppEngine(remote, store);
    assert.equal(boot.git, 'cloned');
    assert.deepEqual(boot.report.downloaded, [obj(B)]);
    assert.ok(h.app.index.getCard(A));
    assert.ok(h.app.index.getCard(B));
    git(other, 'pull', '-q', 'origin', 'main');
    assert.match(git(other, 'log', '--oneline', '-1'), new RegExp(`add ${B}`), '補的 commit 推上去了');
  });

  test('第一次部署（bucket 是空的）：GitHub 上的卡全部傳上 bucket', async () => {
    const { remote, other } = bareRemote();
    pushFromOther(other, A, cardText(A, 'a'));
    pushFromOther(other, B, cardText(B, 'b'));
    const store = new FakeStore();
    const { boot, h } = await bootLikeAppEngine(remote, store);
    assert.deepEqual(boot.report.uploaded, [obj(A), obj(B)]);
    assert.equal(h.app.index.countCards(), 2);
  });

  test('clone 失敗（GitHub 掛了）：只用 bucket 開機，git 備份停用，bucket 一個都不刪', async () => {
    const store = new FakeStore();
    store.seedMirror(obj(A), cardText(A, 'a'));
    const missing = path.join(os.tmpdir(), `no-such-remote-${Date.now()}.git`);
    const { boot, h } = await bootLikeAppEngine(missing, store);
    assert.equal(boot.git, 'unavailable');
    assert.deepEqual(boot.report.downloaded, [obj(A)]);
    assert.equal(store.objects.size, 1);
    assert.equal(h.app.git.status.enabled, false);
    assert.ok(h.app.index.getCard(A));
  });

  test('「更新」：取回別處推上來的修改，傳上 bucket', async () => {
    const { remote, other } = bareRemote();
    pushFromOther(other, A, cardText(A, '第一版'));
    const store = new FakeStore();
    const { h } = await bootLikeAppEngine(remote, store);

    pushFromOther(other, A, cardText(A, '別處改的第二版'));
    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('雲端儲存'));
    assert.ok(res.body.includes('傳上 bucket 1'));
    assert.equal(store.text(obj(A)), cardText(A, '別處改的第二版'));
    assert.equal(h.app.index.getCard(A)?.title, '別處改的第二版');
  });

  test('「更新」時 bucket 掛了：git 照樣取回，頁面說對帳沒成功', async () => {
    const { remote } = bareRemote();
    const store = new FakeStore();
    const { h } = await bootLikeAppEngine(remote, store);
    store.down = true;
    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('沒有對帳成功'));
    assert.ok(res.body.includes('bucket 掛了'));
  });

  test('push 被拒絕（別處先推了）：自動取回、對帳、再推上去', async () => {
    const { remote, other } = bareRemote();
    const store = new FakeStore();
    const { h } = await bootLikeAppEngine(remote, store);

    pushFromOther(other, A, cardText(A, '別處推的'));
    const mine = await createCard(h, { type: 'original', title: '網頁寫的' });

    await until(() => h.app.index.getCard(A) !== null);
    await until(() => {
      try {
        git(other, 'pull', '-q', 'origin', 'main');
        return readLocal(other, mine) !== null;
      } catch {
        return false;
      }
    });
    assert.equal(store.text(obj(A)), cardText(A, '別處推的'), '取回的修改也傳上 bucket');
  });

  test('補 commit 也包含刪除', async () => {
    const ws = makeWorkspace();
    gitInit(ws.corpus);
    const h = await start(ws);
    cleanups.push(h.close);
    const id = await createCard(h, { type: 'original', title: '會被刪' });
    await h.app.git.drain();
    fs.rmSync(path.join(ws.corpus, 'cards', `${id}.md`));
    await h.app.git.commitAndPush();
    assert.match(git(ws.corpus, 'log', '--oneline', '-1'), new RegExp(`rm ${id}`));
  });
});

// ---------------------------------------------------------------- IAP

describe('IAP：沒經過 Google 登入的請求一律 403', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };
  const AUD = '/projects/123/apps/demo';
  const NOW = 1_800_000_000_000;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

  function sign(claims: object, header: object = { alg: 'ES256', kid: 'k1' }): string {
    const data = `${b64(header)}.${b64(claims)}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${data}.${sig.toString('base64url')}`;
  }
  const good = (over: object = {}) => ({
    iss: 'https://cloud.google.com/iap',
    aud: AUD,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 600,
    email: 'me@example.com',
    ...over,
  });

  function verifier() {
    let fetches = 0;
    let now = NOW;
    const verify = createIapVerifier({
      audience: AUD,
      fetchKeys: async () => {
        fetches += 1;
        return [jwk];
      },
      now: () => now,
    });
    return { verify, fetches: () => fetches, advance: (ms: number) => (now += ms) };
  }

  test('簽章、iss、aud、時間都對：回傳登入者', async () => {
    const { verify } = verifier();
    assert.equal(await verify(sign(good())), 'me@example.com');
  });

  test('任何一項不對都不過', async () => {
    const { verify } = verifier();
    assert.equal(await verify(undefined), null);
    assert.equal(await verify('not.a.jwt'), null);
    assert.equal(await verify(sign(good({ aud: '/projects/999/apps/other' }))), null);
    assert.equal(await verify(sign(good({ iss: 'https://evil.example' }))), null);
    assert.equal(await verify(sign(good({ exp: NOW / 1000 - 120 }))), null, '過期');
    assert.equal(await verify(sign(good({ iat: NOW / 1000 + 600 }))), null, '簽發時間在未來');
    assert.equal(await verify(sign(good(), { alg: 'HS256', kid: 'k1' })), null);
    const [h, , s] = sign(good()).split('.');
    assert.equal(await verify(`${h}.${b64(good({ email: 'x@y' }))}.${s}`), null, '改過內容');
  });

  test('沒見過的 kid 會重抓公鑰，但不會每個請求都抓', async () => {
    const v = verifier();
    await v.verify(sign(good()));
    assert.equal(v.fetches(), 1);
    await v.verify(sign(good(), { alg: 'ES256', kid: 'unknown' }));
    assert.equal(v.fetches(), 1, '十秒內不重抓');
    v.advance(11_000);
    await v.verify(sign(good({ iat: (NOW + 11_000) / 1000 - 1 }), { alg: 'ES256', kid: 'unknown' }));
    assert.equal(v.fetches(), 2);
  });

  test('app：沒帶 JWT 的請求 403，連靜態檔也是；/_ah/warmup 不檢查', async () => {
    const ws = makeWorkspace();
    const h = await start({ ...ws, iap: async (t) => (t === 'ok' ? 'me@example.com' : null) });
    cleanups.push(h.close);
    const get = (url: string, token?: string) =>
      h.app.fastify.inject({
        url,
        headers: token ? { 'x-goog-iap-jwt-assertion': token } : {},
      });
    assert.equal((await get('/')).statusCode, 403);
    assert.equal((await get('/static/css/base.css')).statusCode, 403);
    assert.equal((await get('/no-such-page')).statusCode, 403);
    assert.equal((await get('/', 'bad')).statusCode, 403);
    assert.equal((await get('/', 'ok')).statusCode, 200);
    assert.equal((await get('/_ah/warmup')).statusCode, 200);
    assert.equal((await get('/_ah/other')).statusCode, 403, '只放過 warmup 那一條');
  });

  test('audience：IAP_AUDIENCE 優先；否則從 metadata server 組出來', async () => {
    assert.equal(await resolveIapAudience({ IAP_AUDIENCE: '/projects/1/apps/x' }), '/projects/1/apps/x');
    const fake = (async (url: string | URL) =>
      new Response(String(url).endsWith('numeric-project-id') ? '42\n' : 'nope')) as typeof fetch;
    assert.equal(await resolveIapAudience({ GOOGLE_CLOUD_PROJECT: 'demo' }, fake), '/projects/42/apps/demo');
  });
});

// ---------------------------------------------------------------- Cloud Storage 的請求

describe('Cloud Storage：送出去的請求', () => {
  type Seen = { method: string; url: string; headers: Record<string, string>; body: Buffer };

  function fakeFetch(handler: (req: Seen, n: number) => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      const req: Seen = {
        method: init?.method ?? 'GET',
        url: String(url),
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0),
      };
      seen.push(req);
      return handler(req, seen.length);
    }) as typeof fetch;
    return { f, seen };
  }
  const gcs = (f: typeof fetch) =>
    new GcsStore({ bucket: 'bk', token: async () => 'tok', fetch: f, retryDelaysMs: [0, 0, 0] });

  test('列出：分頁接起來、只收卡片、metadata 對到 blob 與 base', async () => {
    const { f, seen } = fakeFetch((_req, n) =>
      Response.json(
        n === 1
          ? {
              items: [
                { name: 'cards/1.md', md5Hash: 'm1', metadata: { 'skynote-blob': 'b1', 'skynote-base': 'a1' } },
                { name: 'cards/sub/x.md', md5Hash: 'mx' },
              ],
              nextPageToken: 'p2',
            }
          : { items: [{ name: 'cards/2.md', md5Hash: 'm2' }] },
      ),
    );
    const list = await gcs(f).list();
    assert.deepEqual(list, [
      { name: 'cards/1.md', md5: 'm1', blob: 'b1', base: 'a1' },
      { name: 'cards/2.md', md5: 'm2', blob: null, base: null },
    ]);
    assert.equal(seen[0]?.headers.authorization, 'Bearer tok');
    assert.match(seen[0]?.url ?? '', /\/b\/bk\/o\?prefix=cards%2F/);
    assert.match(seen[1]?.url ?? '', /pageToken=p2/);
  });

  test('寫入：一次 multipart，內容與 metadata 一起；新卡帶 ifGenerationMatch=0', async () => {
    const { f, seen } = fakeFetch(() => Response.json({}));
    await gcs(f).put('cards/1.md', '內容', { blob: 'bb', base: 'none', ifGenerationMatch: 0 });
    const req = seen[0];
    assert.equal(req?.method, 'POST');
    assert.match(req?.url ?? '', /upload\/storage\/v1\/b\/bk\/o\?uploadType=multipart&ifGenerationMatch=0/);
    assert.match(req?.headers['content-type'] ?? '', /^multipart\/related; boundary=/);
    const body = req?.body.toString('utf8') ?? '';
    assert.ok(body.includes('"name":"cards/1.md"'));
    assert.ok(body.includes('"skynote-blob":"bb"'));
    assert.ok(body.includes('"skynote-base":"none"'));
    assert.ok(body.includes('內容'));
  });

  test('寫入撞號（412）：StoreConflictError，不重試', async () => {
    const { f, seen } = fakeFetch(() => new Response('precondition', { status: 412 }));
    await assert.rejects(
      gcs(f).put('cards/1.md', 'x', { blob: 'b', base: 'none', ifGenerationMatch: 0 }),
      StoreConflictError,
    );
    assert.equal(seen.length, 1);
  });

  test('第一次 503、重試拿到 412：內容一樣就是第一次其實寫進去了，算成功', async () => {
    const content = '內容';
    const { f, seen } = fakeFetch((req, n) => {
      if (n === 1) return new Response('busy', { status: 503 });
      if (req.method === 'POST') return new Response('precondition', { status: 412 });
      return Response.json({ md5Hash: md5Base64(content) });
    });
    await gcs(f).put('cards/1.md', content, { blob: 'b', base: 'none', ifGenerationMatch: 0 });
    assert.equal(seen.length, 3);
  });

  test('一直 503：重試完就放棄，丟 HttpError', async () => {
    const { f, seen } = fakeFetch(() => new Response('busy', { status: 503 }));
    await assert.rejects(gcs(f).get('cards/1.md'), (e: unknown) => e instanceof HttpError && e.status === 503);
    assert.equal(seen.length, 4);
  });

  test('網路錯誤會重試；讀取的物件名稱要編碼', async () => {
    const { f, seen } = fakeFetch((_req, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return new Response('hello');
    });
    assert.equal((await gcs(f).get('cards/1.md')).toString(), 'hello');
    assert.match(seen[1]?.url ?? '', /\/o\/cards%2F1\.md\?alt=media$/);
  });

  test('刪除不存在的物件算成功', async () => {
    const { f } = fakeFetch(() => new Response('nope', { status: 404 }));
    await gcs(f).delete('cards/1.md');
  });
});

// ---------------------------------------------------------------- 設定

describe('設定', () => {
  test('預設：只聽 localhost、沒有雲端、不要求 IAP', () => {
    const c = loadConfig({});
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.cloud, null);
    assert.equal(c.requireIap, false);
  });

  test('CORPUS_BUCKET 的 {project} 換成專案 ID；不知道專案就開不了機', () => {
    const c = loadConfig({
      CORPUS_BUCKET: '{project}-corpus',
      GOOGLE_CLOUD_PROJECT: 'demo',
      CORPUS_REMOTE: 'https://github.com/o/r.git',
      CORPUS_GIT_TOKEN_SECRET: 'corpus-git-token',
      REQUIRE_IAP: '1',
      HOST: '0.0.0.0',
    });
    assert.equal(c.cloud?.bucket, 'demo-corpus');
    assert.equal(c.cloud?.remote, 'https://github.com/o/r.git');
    assert.equal(c.cloud?.tokenSecret, 'corpus-git-token');
    assert.equal(c.requireIap, true);
    assert.equal(c.host, '0.0.0.0');
    assert.throws(() => loadConfig({ CORPUS_BUCKET: '{project}-corpus' }), /GOOGLE_CLOUD_PROJECT/);
  });

  test('GitHub token 用環境變數交給 git，只對 remote 那台主機生效、不寫進檔案', () => {
    const env: NodeJS.ProcessEnv = {};
    useGitToken('https://github.com/o/r.git', 'tok', env);
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    const value = env.GIT_CONFIG_VALUE_0 ?? '';
    assert.match(value, /^AUTHORIZATION: basic /);
    assert.equal(Buffer.from(value.split(' ').at(-1) ?? '', 'base64').toString(), 'x-access-token:tok');
    useGitToken('https://github.com/o/r.git', 'tok2', env);
    assert.equal(env.GIT_CONFIG_COUNT, '2', '已經有的設定不被蓋掉');
  });
});
