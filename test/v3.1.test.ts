import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { cardExists, findCard, readCard } from '../src/store/files.ts';
import { formatEnvOrder, readEnvOrder } from '../src/store/envorder.ts';
import { parseList } from '../src/store/yamllist.ts';
import { checkEnvName, ENV_NAME_MAX } from '../src/service/envs.ts';
import { createCard, gitInit, makeWorkspace, start, type Harness } from './helpers.ts';

/** v3.1 規格（spec/Append_cards_v3.1_spec.md）：環境，以及同批的介面調整。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(opts: { git?: boolean } = {}): Promise<Harness> {
  const ws = makeWorkspace();
  if (opts.git) gitInit(ws.corpus);
  const h = await start(ws);
  cleanups.push(h.close);
  return h;
}

function main(body: string): string {
  return body.slice(body.indexOf('<main>'), body.indexOf('</main>'));
}

function aside(body: string): string {
  return body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
}

/** 環境面板（齒輪打開的那一塊）。 */
function panel(body: string): string {
  return body.slice(body.indexOf('<div class="envpanel"'), body.indexOf('<main>'));
}

const enc = encodeURIComponent;
const base = (env: string) => (env === '' ? '' : `/e/${enc(env)}`);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

/** 環境面板的新增：瀏覽器送出的表單。 */
async function newEnv(h: Harness, name: string, from = '') {
  return h.app.fastify.inject({
    method: 'POST',
    url: '/envs',
    payload: `name=${enc(name)}&from=${enc(from)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

async function renameEnv(h: Harness, from: string, name: string, extra: { at?: string; referer?: string } = {}) {
  return h.app.fastify.inject({
    method: 'POST',
    url: '/envs/rename',
    payload: `from=${enc(from)}&name=${enc(name)}${extra.at === undefined ? '' : `&at=${enc(extra.at)}`}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'skynote.test',
      ...(extra.referer === undefined ? {} : { referer: extra.referer }),
    },
  });
}

/** 環境面板的拖曳排序：envs.js 送出的請求。 */
async function orderEnvs(h: Harness, order: string[]) {
  return h.app.fastify.inject({
    method: 'POST',
    url: '/envs/order',
    payload: { order },
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
}

/** 在某個環境裡建一張卡（那個環境的 /new），回傳 ID。 */
async function cardIn(
  h: Harness,
  env: string,
  payload: Record<string, unknown> & { type: string; title: string },
): Promise<string> {
  const res = await h.app.fastify.inject({
    method: 'POST',
    url: `${base(env)}/new`,
    payload:
      payload.type === 'thinking' && payload.tags === undefined ? { ...payload, tags: ['測試'] } : payload,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
  assert.equal(res.statusCode, 302, res.body);
  return (res.json() as { id: string }).id;
}

/** 在某個環境的隨手記寫一則碎片。 */
async function quickIn(h: Harness, env: string, body: string, tags = '') {
  return h.app.fastify.inject({
    method: 'POST',
    url: `${base(env)}/quick`,
    payload: { body, tags },
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
}

/** 手寫一張卡片檔到某個資料夾，像是在別處的 clone 裡搬好、放進去的。 */
function writeCardAt(
  corpus: string,
  env: string,
  card: { id: string; type?: string; title: string; created?: string; tags?: string[] },
): void {
  const dir = env === '' ? path.join(corpus, 'cards') : path.join(corpus, 'cards', env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${card.id}.md`),
    [
      '---',
      `id: "${card.id}"`,
      `type: ${card.type ?? 'original'}`,
      `created: "${card.created ?? '2026-09-03T00:00:00.000Z'}"`,
      `title: ${card.title}`,
      `tags: [${(card.tags ?? []).join(', ')}]`,
      'url: null',
      'provenance: null',
      'source_author: null',
      'source_date: null',
      'revised: null',
      'links: []',
      '---',
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** 側欄環境清單的名字，照畫面上的順序。目前所在的那一個前面加 *。 */
function envNames(body: string): string[] {
  const nav = aside(body).slice(aside(body).indexOf('drawerenvs'));
  const list = nav.slice(0, nav.indexOf('</nav>'));
  return [...list.matchAll(/<a href="[^"]*" data-env="[^"]*" class="([^"]*)"><span\s+class="indextitle">([^<]*)<\/span>/g)].map(
    (m) => ((m[1] ?? '').split(' ').includes('on') ? `*${m[2]}` : (m[2] ?? '')),
  );
}

/** 環境面板裡的名字，照畫面上的順序。 */
function panelNames(body: string): string[] {
  return [...panel(body).matchAll(/<li class="envitem" data-env="([^"]*)">/g)].map((m) => m[1] ?? '');
}

// ---------------------------------------------------------------- 名稱

describe('§2.2 環境名稱', () => {
  test('能當資料夾名稱、clone 到 Windows 也不出事的才收', () => {
    for (const ok of ['繪圖', '故事與創意發想', '雜事 與 資料', '50%', 'C#', 'a.b', '（舊）']) {
      assert.deepEqual(checkEnvName(ok, []).errors, [], ok);
    }
    const bad: [string, RegExp][] = [
      ['', /不得為空/],
      ['   ', /不得為空/],
      ['a/b', /不能含有/],
      ['a\\b', /不能含有/],
      ['a:b', /不能含有/],
      ['a|b', /不能含有/],
      ['a?b', /不能含有/],
      ['a*b', /不能含有/],
      ['"引號"', /不能含有/],
      ['<x>', /不能含有/],
      ['tab\there', /不能含有/],
      ['.hidden', /開頭/],
      ['..', /開頭/],
      ['結尾.', /結尾/],
      ['CON', /保留名稱/],
      ['con.txt', /保留名稱/],
      ['Lpt1', /保留名稱/],
      ['字'.repeat(ENV_NAME_MAX + 1), /最多/],
    ];
    for (const [name, re] of bad) {
      assert.match(checkEnvName(name, []).errors.join(' | '), re, JSON.stringify(name));
    }
    assert.deepEqual(checkEnvName('字'.repeat(ENV_NAME_MAX), []).errors, []);
  });

  test('去掉首尾空白、統一成 NFC；同名不分大小寫', () => {
    assert.equal(checkEnvName('  繪圖  ', []).name, '繪圖');
    assert.equal(checkEnvName('Café', []).name, 'Café');
    assert.match(checkEnvName('draw', ['Draw']).errors.join(), /已經有「Draw」/);
  });
});

// ---------------------------------------------------------------- 建立與資料配置

describe('§2.2 資料配置：環境就是 cards/ 底下的一層資料夾', () => {
  test('新增環境：開一個資料夾，進到那個環境；名稱不合格或重複就說原因', async () => {
    const h = await fresh();
    const res = await newEnv(h, '繪圖');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/e/${enc('繪圖')}/`);
    assert.ok(fs.statSync(path.join(h.corpus, 'cards', '繪圖')).isDirectory());

    const page = await h.app.fastify.inject(`/e/${enc('繪圖')}/`);
    assert.equal(page.statusCode, 200);
    assert.deepEqual(envNames(page.body), ['*繪圖']);
    assert.ok(main(page.body).includes('沒有卡片。'));

    const dup = await newEnv(h, '繪圖');
    assert.equal(dup.statusCode, 400);
    assert.ok(main(dup.body).includes('已經有「繪圖」這個環境'));
    const bad = await newEnv(h, 'a/b', '繪圖');
    assert.equal(bad.statusCode, 400);
    assert.ok(main(bad.body).includes('不能含有'));
    assert.ok(main(bad.body).includes(`href="/e/${enc('繪圖')}/"`), '附一條回去的路');
  });

  test('寫進環境的卡落在那個資料夾；卡片檔不記錄環境，commit 照舊一張一個', async () => {
    const h = await fresh({ git: true });
    await newEnv(h, '學校');
    const quick = await quickIn(h, '學校', '下週交報告');
    assert.equal(quick.statusCode, 302);
    assert.equal(quick.headers.location, `/e/${enc('學校')}/`, '碎片回到它所在環境的首頁');
    const id = (quick.json() as { id: string }).id;

    const file = path.join(h.corpus, 'cards', '學校', `${id}.md`);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(h.corpus, 'cards', `${id}.md`)));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('學校'), 'frontmatter 沒有環境這個欄位');
    assert.equal(findCard(h.corpus, id)?.env, '學校');
    assert.ok(cardExists(h.corpus, id), '依 ID 找檔案看過每一個資料夾');

    await h.app.git.drain();
    assert.match(git(h.corpus, 'log', '--oneline', '-1'), new RegExp(`add ${id}`));
    assert.equal(git(h.corpus, 'ls-files', 'cards').trim(), `cards/學校/${id}.md`);
  });

  test('修改、勾選、刪除都找得到環境裡的卡，動的是那個資料夾裡的檔', async () => {
    const h = await fresh({ git: true });
    await newEnv(h, '專題');
    const id = await cardIn(h, '專題', { type: 'original', title: '一份資料', body: '- [ ] 一件事' });
    const file = path.join(h.corpus, 'cards', '專題', `${id}.md`);

    const put = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${id}`,
      payload: { title: '改過的標題' },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(readCard(h.corpus, id).title, '改過的標題');
    assert.ok(fs.readFileSync(file, 'utf8').includes('改過的標題'));

    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    const rev = /class="body"[^>]*data-rev="([0-9a-f]+)"/.exec(page)?.[1] ?? '';
    const check = await h.app.fastify.inject({
      method: 'POST',
      url: `/c/${id}/tasks/0`,
      payload: { checked: true, rev },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(check.statusCode, 200);
    assert.ok(fs.readFileSync(file, 'utf8').includes('- [x] 一件事'));
    // commit 是排隊做的；等它們做完再刪，git 裡才有東西可刪。
    await h.app.git.drain();
    assert.match(git(h.corpus, 'log', '--format=%s', '-1'), new RegExp(`(add|edit|check) ${id}`));

    // 編輯頁刪掉之後回到這張卡所在環境的首頁，不是 /。
    const edit = (await h.app.fastify.inject(`/c/${id}/edit`)).body;
    assert.ok(edit.includes(`data-home="/e/${enc('專題')}/"`));
    assert.match(fs.readFileSync(path.join('public', 'js', 'editform.js'), 'utf8'), /form\.dataset\.home/);

    const del = await h.app.fastify.inject({ method: 'DELETE', url: `/c/${id}` });
    assert.equal(del.statusCode, 200);
    assert.ok(!fs.existsSync(file));
    await h.app.git.drain();
    assert.match(git(h.corpus, 'log', '--oneline', '-1'), new RegExp(`rm ${id}`));
    assert.equal(git(h.corpus, 'ls-files', 'cards').trim(), '');
  });

  test('重建索引讀得到每個環境；同一個 ID 在兩個資料夾、多套一層資料夾，都列進報告而不中斷', async () => {
    const h = await fresh();
    writeCardAt(h.corpus, '', { id: '88800000000000001', title: '沒有環境的' });
    writeCardAt(h.corpus, '繪圖', { id: '88800000000000002', title: '繪圖的' });
    writeCardAt(h.corpus, '繪圖', { id: '88800000000000001', title: '重複的' });
    writeCardAt(h.corpus, path.join('繪圖', '多一層'), { id: '88800000000000003', title: '太深的' });

    const report = h.app.index.rebuild();
    assert.equal(report.indexed, 2);
    assert.equal(h.app.index.getCard('88800000000000001')?.env, '', '沒有環境的那份先到');
    assert.equal(h.app.index.getCard('88800000000000002')?.env, '繪圖');
    assert.equal(h.app.index.getCard('88800000000000003'), null);
    const failures = report.failures.map((f) => `${f.file}：${f.error}`).join('\n');
    assert.match(failures, /cards\/繪圖\/88800000000000001\.md：ID 跟 cards\/88800000000000001\.md 重複/);
    assert.match(failures, /cards\/繪圖\/多一層\/：環境只有一層/);
  });
});

// ---------------------------------------------------------------- 網址與範圍

describe('§2.3–2.5、§2.8 網址、各功能的範圍與側欄', () => {
  test('每個環境有自己的時間軸；沒有環境沿用既有的網址', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await createCard(h, { type: 'original', title: '還沒搬的舊卡' });
    await cardIn(h, '繪圖', { type: 'original', title: '繪圖的資料' });

    const root = main((await h.app.fastify.inject('/')).body);
    assert.ok(root.includes('還沒搬的舊卡'));
    assert.ok(!root.includes('繪圖的資料'), '一個環境裡看不到其他環境的卡');

    const draw = await h.app.fastify.inject(`/e/${enc('繪圖')}/`);
    assert.ok(main(draw.body).includes('繪圖的資料'));
    assert.ok(!main(draw.body).includes('還沒搬的舊卡'));
    // 篩選、分頁、標籤連結都留在這個環境。
    assert.ok(main(draw.body).includes(`href="/e/${enc('繪圖')}/?type=original"`));

    const noSlash = await h.app.fastify.inject(`/e/${enc('繪圖')}?type=original`);
    assert.equal(noSlash.statusCode, 302);
    assert.equal(noSlash.headers.location, `/e/${enc('繪圖')}/?type=original`);

    const missing = await h.app.fastify.inject(`/e/${enc('不存在')}/`);
    assert.equal(missing.statusCode, 404);
    assert.ok(main(missing.body).includes('沒有這個環境'));
    // 網址裡的名字只跟實際列出來的資料夾比對，走不出 cards/。
    assert.equal((await h.app.fastify.inject(`/e/${enc('../cards')}/tags`)).statusCode, 404);

    // 最長的名字編碼之後有 360 字元，路由的參數長度上限（100）算的是解碼之後的長度。
    const long = '長'.repeat(40);
    assert.equal((await newEnv(h, long)).statusCode, 302);
    assert.equal((await h.app.fastify.inject(`/e/${enc(long)}/search`)).statusCode, 200);
  });

  test('側欄：環境依最近一張卡排，空的排最後；（無環境）沒有卡就不列', async () => {
    const h = await fresh();
    for (const name of ['甲', '乙', '丙']) await newEnv(h, name);
    writeCardAt(h.corpus, '甲', { id: '88800000000000001', title: 'a', created: '2026-10-01T00:00:00.000Z' });
    writeCardAt(h.corpus, '乙', { id: '88800000000000002', title: 'b', created: '2026-10-02T00:00:00.000Z' });
    writeCardAt(h.corpus, '', { id: '88800000000000003', title: 'c', created: '2026-09-01T00:00:00.000Z' });
    h.app.index.rebuild();

    const page = (await h.app.fastify.inject(`/e/${enc('甲')}/`)).body;
    assert.deepEqual(envNames(page), ['乙', '*甲', '（無環境）', '丙']);
    assert.deepEqual(panelNames(page), ['乙', '甲', '丙'], '面板跟側欄同一個順序，沒有（無環境）');

    fs.rmSync(path.join(h.corpus, 'cards', '88800000000000003.md'));
    h.app.index.rebuild();
    assert.deepEqual(envNames((await h.app.fastify.inject(`/e/${enc('甲')}/`)).body), ['乙', '*甲', '丙']);
  });

  test('（無環境）搬空了：它的頁面導向最近寫過的環境；還有卡、或還沒有環境時照舊', async () => {
    const h = await fresh();
    assert.equal((await h.app.fastify.inject('/')).statusCode, 200, '還沒有任何環境');

    await newEnv(h, '雜事');
    await newEnv(h, '繪圖');
    await cardIn(h, '繪圖', { type: 'original', title: '最近的' });

    const home = await h.app.fastify.inject('/');
    assert.equal(home.statusCode, 302);
    assert.equal(home.headers.location, `/e/${enc('繪圖')}/`);
    const tags = await h.app.fastify.inject('/tags?sort=name');
    assert.equal(tags.headers.location, `/e/${enc('繪圖')}/tags?sort=name`, '舊書籤照樣能用');

    await createCard(h, { type: 'original', title: '還有一張沒搬' });
    assert.equal((await h.app.fastify.inject('/')).statusCode, 200);
  });

  test('標籤、標籤推薦、側欄的最近標籤與最近卡片都以環境為界', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await createCard(h, { type: 'original', title: '舊卡', tags: ['只在舊的'] });
    const id = await cardIn(h, '繪圖', { type: 'original', title: '構圖筆記', tags: ['構圖'] });

    const tags = main((await h.app.fastify.inject(`/e/${enc('繪圖')}/tags`)).body);
    assert.ok(tags.includes('#構圖'));
    assert.ok(!tags.includes('#只在舊的'));
    assert.ok(tags.includes(`href="/e/${enc('繪圖')}/?tag=${enc('構圖')}"`));

    const feed = (await h.app.fastify.inject(`/e/${enc('繪圖')}/`)).body;
    assert.ok(aside(feed).includes('#構圖') && !aside(feed).includes('#只在舊的'));

    const form = (await h.app.fastify.inject(`/e/${enc('繪圖')}/new?type=original`)).body;
    const suggest = /data-tags='([^']*)'/.exec(form)?.[1] ?? '';
    assert.ok(suggest.includes('構圖') && !suggest.includes('只在舊的'), '推薦的是這個環境用過的標籤');
    assert.ok(main(form).includes(`action="/e/${enc('繪圖')}/new"`));

    const card = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.ok(aside(card).includes('構圖筆記') && !aside(card).includes('舊卡'), '最近的卡片也只列這個環境的');
  });

  test('卡片頁的網址不帶環境，外殼以那張卡所屬的環境為準', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await newEnv(h, '學校');
    const id = await cardIn(h, '繪圖', { type: 'thinking', title: '光影', tags: ['光'] });

    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.deepEqual(envNames(page).filter((n) => n.startsWith('*')), ['*繪圖']);
    assert.ok(main(page).includes(`href="/e/${enc('繪圖')}/?tag=${enc('光')}"`), '標籤連回那個環境');
    assert.ok(main(page).includes(`href="/e/${enc('繪圖')}/"`), '返回那個環境的首頁');
    assert.ok(page.includes(`href="/e/${enc('繪圖')}/new?type=thinking&amp;rel=supports&amp;to=${id}"`));
    // 側欄的每一項都指向這個環境。
    for (const href of ['/', '/search', '/tags', '/new?type=original']) {
      assert.ok(aside(page).includes(`href="/e/${enc('繪圖')}${href}"`), href);
    }
    assert.ok(aside(page).includes('<input type="hidden" name="env" value="繪圖">'), '更新之後留在這裡');
  });

  test('側欄的清單只拿來切換；新增、排序、改名在齒輪打開的面板裡，（無環境）不在面板裡', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await newEnv(h, '學校');
    await createCard(h, { type: 'original', title: '舊卡' });

    const page = (await h.app.fastify.inject(`/e/${enc('繪圖')}/`)).body;
    assert.match(aside(page), /<button type="button" class="envgear" popovertarget="envpanel"/);
    assert.ok(!aside(page).includes('<form method="post" action="/envs'), '側欄裡沒有環境的表單');

    const p = panel(page);
    assert.match(p, /<div class="envpanel" id="envpanel" popover/);
    assert.equal(p.match(/class="envedit"/g)?.length, 2, '每個環境都能改名');
    assert.equal(p.match(/class="envgrip"/g)?.length, 2);
    for (const name of ['繪圖', '學校']) assert.ok(p.includes(`<input type="hidden" name="from" value="${name}">`));
    assert.ok(p.includes('<input type="hidden" name="at" value="繪圖">'), '沒改成時留在這個環境');
    assert.ok(!p.includes('（無環境）'));
    assert.ok(p.includes('<form method="post" action="/envs" class="envform envnew">'));
    assert.ok(page.includes('<script src="/static/js/envs.js" defer></script>'));

    // 還沒有任何環境：面板裡只有新增。
    const empty = await fresh();
    const only = panel((await empty.app.fastify.inject('/')).body);
    assert.ok(!only.includes('envsort') && only.includes('action="/envs"'));
  });

  test('草稿槽帶著環境：兩個環境的隨手記不共用一格；以卡片為鍵的不受影響', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    const src = await cardIn(h, '繪圖', { type: 'original', title: '母卡' });
    const scope = async (url: string) =>
      [...(await h.app.fastify.inject(url)).body.matchAll(/data-draft-scope="([^"]*)"/g)].map((m) => m[1]);

    assert.deepEqual(await scope(`/e/${enc('繪圖')}/`), ['繪圖|quick']);
    assert.deepEqual(await scope(`/e/${enc('繪圖')}/?tag=${enc('構圖')}`), ['繪圖|quick:tag:構圖']);
    assert.deepEqual(await scope(`/e/${enc('繪圖')}/new?type=original`), ['繪圖|new:original']);
    assert.deepEqual(
      await scope(`/e/${enc('繪圖')}/new?type=thinking&rel=about&to=${src}`),
      [`new:thinking:about:${src}`],
    );

    const expand = await h.app.fastify.inject({
      method: 'POST',
      url: `/e/${enc('繪圖')}/quick`,
      payload: `body=${enc('寫到一半')}&expand=1&draft_scope=${enc('繪圖|quick')}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.ok(expand.body.includes('data-draft-scope="繪圖|new:thinking:expand"'));
    assert.ok(expand.body.includes(`action="/e/${enc('繪圖')}/new"`), '展開之後照樣寫進這個環境');
  });
});

// ---------------------------------------------------------------- 搜尋

describe('§2.5 搜尋：這個環境或所有環境', () => {
  test('預設只搜這個環境；切到所有環境時，別的環境的卡標出環境名', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await newEnv(h, '學校');
    await cardIn(h, '繪圖', { type: 'original', title: '色彩的筆記', body: '關鍵字在這裡' });
    await cardIn(h, '學校', { type: 'original', title: '課堂的筆記', body: '關鍵字也在這裡', tags: ['課'] });

    const here = main((await h.app.fastify.inject(`/e/${enc('繪圖')}/search?q=${enc('關鍵字')}`)).body);
    assert.ok(here.includes('色彩的筆記') && !here.includes('課堂的筆記'));
    assert.ok(here.includes(`href="/e/${enc('繪圖')}/search?q=${enc('關鍵字')}&all=1"`), '切換鈕');

    const all = main((await h.app.fastify.inject(`/e/${enc('繪圖')}/search?q=${enc('關鍵字')}&all=1`)).body);
    assert.ok(all.includes('色彩的筆記') && all.includes('課堂的筆記'));
    assert.match(all, /<span class="envmark">學校<\/span>/);
    assert.ok(!all.includes('<span class="envmark">繪圖</span>'), '這個環境的卡不必標');
    assert.ok(all.includes(`href="/e/${enc('學校')}/?tag=${enc('課')}"`), '標籤連回那張卡的環境');
    assert.ok(all.includes('<input type="hidden" name="all" value="1">'), '換關鍵字時範圍留著');
    assert.ok(all.includes('&amp;all=1&type=original'), '型別篩選也留著範圍');
  });

  test('只有一個環境時沒有範圍可切', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '唯一的', body: '關鍵字' });
    const page = main((await h.app.fastify.inject(`/search?q=${enc('關鍵字')}&all=1`)).body);
    assert.ok(!page.includes('所有環境'));
    assert.ok(page.includes('唯一的'));
  });
});

// ---------------------------------------------------------------- 跨環境

describe('§2.6 新卡落在哪裡、§2.5 連結跨環境', () => {
  test('卡片頁 + 進來的表單：預設是來源卡的環境，可以改選；連結跨過去，兩邊的串都標出環境名', async () => {
    const h = await fresh();
    await newEnv(h, '故事');
    await newEnv(h, '專題');
    const idea = await cardIn(h, '故事', { type: 'thinking', title: '最早的發想', tags: ['發想'] });

    const form = (await h.app.fastify.inject(`/e/${enc('故事')}/new?type=thinking&rel=supports&to=${idea}`)).body;
    assert.match(main(form), /<select name="env">[\s\S]*<option value="故事" selected>故事<\/option>/);
    assert.ok(main(form).includes('<option value="專題" >專題</option>'));

    const res = await h.app.fastify.inject({
      method: 'POST',
      url: `/e/${enc('故事')}/new`,
      payload: { type: 'thinking', title: '專題的起點', tags: ['發想'], env: '專題', links: [{ rel: 'supports', to: idea }] },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(res.statusCode, 302, res.body);
    const id = (res.json() as { id: string }).id;
    assert.equal(findCard(h.corpus, id)?.env, '專題');

    const child = main((await h.app.fastify.inject(`/c/${id}`)).body);
    assert.match(child, /最早的發想<\/a>\s*<span class="envmark">故事<\/span>/);
    const parent = main((await h.app.fastify.inject(`/c/${idea}`)).body);
    assert.match(parent, /專題的起點<\/a>\s*<span class="envmark">專題<\/span>/);

    // 被任何環境的卡指向都會定案（R6）。
    const edit = await h.app.fastify.inject(`/c/${idea}/edit`);
    assert.equal(edit.statusCode, 403);
  });

  test('只有一個環境可選時不問；其他入口落在目前所在的環境', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    const src = await cardIn(h, '繪圖', { type: 'original', title: '母卡' });
    const form = main((await h.app.fastify.inject(`/e/${enc('繪圖')}/new?type=thinking&rel=about&to=${src}`)).body);
    assert.ok(!form.includes('name="env"'));
    const bare = main((await h.app.fastify.inject(`/e/${enc('繪圖')}/new?type=original`)).body);
    assert.ok(!bare.includes('name="env"'));
  });

  test('表單選的環境不存在（剛被改名）就退回，不寫到別的地方', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: `/e/${enc('繪圖')}/new`,
      payload: { type: 'original', title: 'x', env: '不存在' },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { errors: string[] }).errors.join(), /沒有「不存在」這個環境/);
    assert.equal(h.app.index.countCards(), 0);
  });

  test('連結的選卡器搜所有環境，目前的環境排前面，帶著環境名', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await newEnv(h, '學校');
    await cardIn(h, '學校', { type: 'original', title: '筆記：學校那份' });
    await cardIn(h, '繪圖', { type: 'original', title: '筆記：繪圖那份' });
    await cardIn(h, '學校', { type: 'original', title: '筆記：學校較新的' });

    const list = (await h.app.fastify.inject(`/api/search?q=${enc('筆記')}&env=${enc('繪圖')}`)).json() as {
      title: string;
      env: string;
      envLabel: string;
    }[];
    assert.deepEqual(
      list.map((r) => r.title),
      ['筆記：繪圖那份', '筆記：學校較新的', '筆記：學校那份'],
    );
    assert.equal(list[1]?.env, '學校');
    assert.equal(list[1]?.envLabel, '學校');

    const form = (await h.app.fastify.inject(`/e/${enc('繪圖')}/new?type=original`)).body;
    assert.ok(form.includes(`data-env="繪圖"`), 'links.js 從這裡知道目前的環境');
    const js = fs.readFileSync(path.join('public', 'js', 'links.js'), 'utf8');
    assert.match(js, /\/api\/search\?limit=10&env=/);
  });
});

// ---------------------------------------------------------------- 改名

describe('§2.7 環境改名', () => {
  test('資料夾換名字，卡片的 ID、內容與連結都不變；舊網址不在了，一個 commit', async () => {
    const h = await fresh({ git: true });
    await newEnv(h, '繪圖');
    const a = await cardIn(h, '繪圖', { type: 'original', title: '構圖' });
    const b = await cardIn(h, '繪圖', { type: 'thinking', title: '光影', links: [{ rel: 'about', to: a }] });
    const before = fs.readFileSync(path.join(h.corpus, 'cards', '繪圖', `${a}.md`), 'utf8');
    await h.app.git.drain();

    const res = await renameEnv(h, '繪圖', '插畫');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `/e/${enc('插畫')}/`);

    assert.ok(!fs.existsSync(path.join(h.corpus, 'cards', '繪圖')));
    assert.equal(fs.readFileSync(path.join(h.corpus, 'cards', '插畫', `${a}.md`), 'utf8'), before);
    assert.equal(h.app.index.getCard(b)?.env, '插畫');
    assert.equal(h.app.index.outLinks(b)[0]?.id, a);
    assert.equal((await h.app.fastify.inject(`/e/${enc('繪圖')}/`)).statusCode, 404);
    assert.ok(main((await h.app.fastify.inject(`/e/${enc('插畫')}/`)).body).includes('光影'));

    await h.app.git.drain();
    assert.match(git(h.corpus, 'log', '--oneline', '-1'), /env 繪圖 → 插畫/);
    assert.deepEqual(
      git(h.corpus, 'ls-files', 'cards').trim().split('\n').sort(),
      [`cards/插畫/${a}.md`, `cards/插畫/${b}.md`].sort(),
    );
    assert.equal(git(h.corpus, 'status', '--porcelain', '--', 'cards').trim(), '', '沒有留下沒 commit 的東西');
  });

  test('空的環境也能改名；新名字不合格、跟別的重複、（無環境）都不行', async () => {
    const h = await fresh({ git: true });
    await newEnv(h, '甲');
    await newEnv(h, '乙');

    assert.equal((await renameEnv(h, '甲', '丙')).statusCode, 302);
    assert.ok(fs.existsSync(path.join(h.corpus, 'cards', '丙')));

    const dup = await renameEnv(h, '丙', '乙');
    assert.equal(dup.statusCode, 400);
    assert.ok(main(dup.body).includes('已經有「乙」這個環境'));
    assert.equal((await renameEnv(h, '丙', 'a:b')).statusCode, 400);
    assert.equal((await renameEnv(h, '', '丁')).statusCode, 400);
    assert.equal((await renameEnv(h, '不存在', '丁')).statusCode, 400);

    const same = await renameEnv(h, '丙', ' 丙 ');
    assert.equal(same.statusCode, 302, '同一個名字什麼都不做');
  });

  test('排隊的 commit 輪到時資料夾已經改名：每一個 commit 裡卡片都在，沒有只剩刪除的版本', async () => {
    const h = await fresh({ git: true });
    await newEnv(h, '甲');
    const ids = [
      await cardIn(h, '甲', { type: 'original', title: '一' }),
      await cardIn(h, '甲', { type: 'original', title: '二' }),
    ];
    await h.app.git.drain();
    const firstFull = git(h.corpus, 'rev-parse', 'HEAD').trim();

    // 不等前一件 commit 做完：一次修改、連著兩次改名。輪到那幾件時，資料夾可能已經是最後的名字。
    const put = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${ids[0]}`,
      payload: { title: '一（改過）' },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal((await renameEnv(h, '甲', '乙')).statusCode, 302);
    assert.equal((await renameEnv(h, '乙', '丙')).statusCode, 302);
    await h.app.git.drain();

    const commits = git(h.corpus, 'rev-list', `${firstFull}..HEAD`).trim().split('\n').filter(Boolean);
    assert.ok(commits.length >= 1);
    for (const c of [firstFull, ...commits]) {
      const files = git(h.corpus, 'ls-tree', '-r', '--name-only', c, 'cards').trim().split('\n');
      assert.equal(files.length, 2, `${git(h.corpus, 'log', '--format=%s', '-1', c).trim()}：${files.join(', ')}`);
    }
    assert.deepEqual(
      git(h.corpus, 'ls-files', 'cards').trim().split('\n').sort(),
      ids.map((id) => `cards/丙/${id}.md`).sort(),
    );
    assert.equal(git(h.corpus, 'status', '--porcelain', '--', 'cards').trim(), '');
  });
});

// ---------------------------------------------------------------- 環境面板

describe('§2.8 環境面板：拖曳排序寫進 envs.yml、每個環境都能改名', () => {
  test('整份順序寫進 envs.yml，側欄與面板照它排；一個 commit，只有這個檔', async () => {
    const h = await fresh({ git: true });
    for (const name of ['甲', '乙', '丙']) await newEnv(h, name);
    writeCardAt(h.corpus, '甲', { id: '88800000000000001', title: 'a', created: '2026-10-01T00:00:00.000Z' });
    writeCardAt(h.corpus, '乙', { id: '88800000000000002', title: 'b', created: '2026-10-02T00:00:00.000Z' });
    h.app.index.rebuild();
    const page = async () => (await h.app.fastify.inject(`/e/${enc('甲')}/`)).body;
    assert.deepEqual(envNames(await page()), ['乙', '*甲', '丙'], '沒排過：照最近一張卡');

    const res = await orderEnvs(h, ['丙', '甲', '乙']);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, order: ['丙', '甲', '乙'] });
    assert.deepEqual(envNames(await page()), ['丙', '*甲', '乙']);
    assert.deepEqual(panelNames(await page()), ['丙', '甲', '乙']);
    assert.deepEqual(readEnvOrder(h.corpus), ['丙', '甲', '乙']);

    await h.app.git.drain();
    assert.equal(git(h.corpus, 'log', '--format=%s', '-1').trim(), 'env order');
    assert.equal(git(h.corpus, 'show', '--name-only', '--format=', 'HEAD').trim(), 'envs.yml');
    const commits = git(h.corpus, 'rev-list', '--count', 'HEAD').trim();

    // 同一份順序再送一次：檔案沒變，沒有新的 commit。
    await orderEnvs(h, ['丙', '甲', '乙']);
    await h.app.git.drain();
    assert.equal(git(h.corpus, 'rev-list', '--count', 'HEAD').trim(), commits);
  });

  test('對不到的名字略過、重複的只算一次；沒送到的照側欄原本的先後接在後面', async () => {
    const h = await fresh();
    for (const name of ['甲', '乙', '丙', '丁']) await newEnv(h, name);
    const res = await orderEnvs(h, ['丙', '不存在', '丙', '甲']);
    assert.deepEqual((res.json() as { order: string[] }).order, ['丙', '甲', '丁', '乙']);

    // 之後新建的環境、還有卡的（無環境），都接在排過的後面，照原本的規則。
    await newEnv(h, '戊');
    await createCard(h, { type: 'original', title: '還沒搬的舊卡' });
    assert.deepEqual(envNames((await h.app.fastify.inject(`/e/${enc('甲')}/`)).body), [
      '丙',
      '*甲',
      '丁',
      '乙',
      '（無環境）',
      '戊',
    ]);
  });

  test('排序不改變 / 通往哪裡：仍是最近寫過的環境', async () => {
    const h = await fresh();
    for (const name of ['甲', '乙']) await newEnv(h, name);
    writeCardAt(h.corpus, '甲', { id: '88800000000000001', title: 'a', created: '2026-10-01T00:00:00.000Z' });
    writeCardAt(h.corpus, '乙', { id: '88800000000000002', title: 'b', created: '2026-10-02T00:00:00.000Z' });
    h.app.index.rebuild();
    await orderEnvs(h, ['甲', '乙']);
    assert.deepEqual(envNames((await h.app.fastify.inject(`/e/${enc('乙')}/`)).body), ['甲', '*乙']);
    assert.equal((await h.app.fastify.inject('/')).headers.location, `/e/${enc('乙')}/`);
  });

  test('改名：envs.yml 裡的名字跟著換、位置不變，跟卡片在同一個 commit', async () => {
    const h = await fresh({ git: true });
    for (const name of ['甲', '乙']) await newEnv(h, name);
    const id = await cardIn(h, '甲', { type: 'original', title: '一張' });
    await orderEnvs(h, ['乙', '甲']);
    await h.app.git.drain();

    assert.equal((await renameEnv(h, '甲', '丙')).statusCode, 302);
    assert.deepEqual(readEnvOrder(h.corpus), ['乙', '丙']);
    await h.app.git.drain();
    assert.equal(git(h.corpus, 'log', '--format=%s', '-1').trim(), 'env 甲 → 丙');
    assert.deepEqual(
      git(h.corpus, 'show', '--no-renames', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(),
      [`cards/丙/${id}.md`, `cards/甲/${id}.md`, 'envs.yml'].sort(),
    );

    // 空的環境沒有卡：排過序的話，commit 裡只有 envs.yml。
    assert.equal((await renameEnv(h, '乙', '丁')).statusCode, 302);
    await h.app.git.drain();
    assert.equal(git(h.corpus, 'log', '--format=%s', '-1').trim(), 'env 乙 → 丁');
    assert.equal(git(h.corpus, 'show', '--name-only', '--format=', 'HEAD').trim(), 'envs.yml');
    assert.deepEqual(readEnvOrder(h.corpus), ['丁', '丙']);
  });

  test('面板裡改名：回到按下去時那一頁；那一頁在被改名的環境底下，就換成新名字的網址', async () => {
    const h = await fresh();
    for (const name of ['繪圖', '學校']) await newEnv(h, name);
    const id = await cardIn(h, '繪圖', { type: 'original', title: '光影' });
    const at = (page: string) => `http://skynote.test${page}`;

    // 改的不是正在看的那一個：原地不動。
    const other = await renameEnv(h, '繪圖', '插畫', { at: '學校', referer: at(`/e/${enc('學校')}/tags?sort=name`) });
    assert.equal(other.headers.location, `/e/${enc('學校')}/tags?sort=name`);
    // 改的是正在看的那一個：同一頁，換成新名字。
    const here = await renameEnv(h, '插畫', '素描', { at: '插畫', referer: at(`/e/${enc('插畫')}/search?q=${enc('光')}`) });
    assert.equal(here.headers.location, `/e/${enc('素描')}/search?q=${enc('光')}`);
    // 卡片頁的網址不帶環境。
    const card = await renameEnv(h, '素描', '繪圖', { referer: at(`/c/${id}`) });
    assert.equal(card.headers.location, `/c/${id}`);

    // 別的站、讀不回來的頁面（上一次沒改成的說明頁）、沒帶 Referer：進到改好的那個環境。
    for (const referer of ['http://elsewhere.test/', at('/envs/rename'), undefined]) {
      const res = await renameEnv(h, '繪圖', '插畫', referer === undefined ? {} : { referer });
      assert.equal(res.headers.location, `/e/${enc('插畫')}/`, String(referer));
      await renameEnv(h, '插畫', '繪圖');
    }

    // 沒改成：說明頁留在按下去時所在的環境。
    const bad = await renameEnv(h, '繪圖', '學校', { at: '學校' });
    assert.equal(bad.statusCode, 400);
    assert.ok(main(bad.body).includes('已經有「學校」這個環境'));
    assert.ok(main(bad.body).includes(`href="/e/${enc('學校')}/"`));
  });

  test('envs.yml 手改壞了也不會壞事：認得的照排，其餘照原本的規則', async () => {
    const h = await fresh();
    for (const name of ['甲', '乙', '丙']) await newEnv(h, name);
    const names = async () => envNames((await h.app.fastify.inject(`/e/${enc('甲')}/`)).body);
    const write = (text: string) => fs.writeFileSync(path.join(h.corpus, 'envs.yml'), text);

    write('order: [乙, 甲]\n');
    assert.deepEqual(await names(), ['丙', '乙', '*甲'], 'inline 陣列不認得：當作沒排過');
    write('order:\n  - 甲   # 第一個\n  - "不存在"\n  - 甲\n');
    assert.deepEqual(await names(), ['*甲', '丙', '乙']);
    write('\u0000\u0001 壞掉的檔案');
    assert.deepEqual(await names(), ['丙', '乙', '*甲']);
  });

  test('envs.yml 的名字一律加引號：含「 #」、開頭是 - 或 # 的名字都讀得回來', () => {
    const names = ['a #b', '- 清單', "it's", '#開頭', 'true', '123'];
    for (const n of names) assert.deepEqual(checkEnvName(n, []).errors, [], n);
    assert.deepEqual(parseList(formatEnvOrder(names), 'order'), names);
  });

  test('envs.yml 寫了還沒 commit 就中斷：開機與「更新」都先補上 commit，取回不會因為工作區不乾淨而失敗', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-v31-'));
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const ws = makeWorkspace();
    gitInit(ws.corpus, remote);
    git(ws.corpus, 'push', '-q', '-u', 'origin', 'main');
    const h = await start(ws);
    cleanups.push(h.close);
    for (const name of ['甲', '乙']) await newEnv(h, name);
    await cardIn(h, '甲', { type: 'original', title: '一張' });
    await orderEnvs(h, ['甲', '乙']);
    await h.app.git.drain();
    const file = path.join(ws.corpus, 'envs.yml');

    // 檔案寫了、commit 還在佇列裡時行程被中斷。開機時補上。
    fs.writeFileSync(file, formatEnvOrder(['乙', '甲']));
    await h.app.git.commitAndPush();
    assert.equal(git(ws.corpus, 'log', '--format=%s', '-1').trim(), 'env order');
    assert.equal(git(ws.corpus, 'status', '--porcelain', '--', 'envs.yml').trim(), '');

    // 又一次中斷，這回別處也推了東西上去，這邊按「更新」。
    fs.writeFileSync(file, formatEnvOrder(['甲', '乙']));
    const other = path.join(dir, 'other');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
    writeCardAt(other, '甲', { id: '88800000000000009', title: '別處寫的' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'add elsewhere');
    git(other, 'push', '-q', 'origin', 'main');

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.ok(res.body.includes('取回了 1 個 commit'), main(res.body));
    assert.equal(git(ws.corpus, 'status', '--porcelain', '--', 'envs.yml').trim(), '');
    assert.equal(h.app.index.getCard('88800000000000009')?.env, '甲');
    assert.ok(git(remote, 'show', 'main:envs.yml').includes('  - "甲"\n  - "乙"'), '順序也推上去了');
  });

  test('拖曳用 Pointer Events，把手不讓觸控捲動面板', () => {
    const js = fs.readFileSync(path.join('public', 'js', 'envs.js'), 'utf8');
    assert.match(js, /addEventListener\('pointerdown'/);
    assert.ok(!/draggable|dragstart/.test(js), '不用 HTML 的 drag and drop：觸控螢幕上不會觸發');
    assert.match(fs.readFileSync(path.join('public', 'css', 'shell.css'), 'utf8'), /\.envgrip \{[^}]*touch-action: none;/);
  });
});

// ---------------------------------------------------------------- 手動搬移

describe('§2.3 （無環境）是過渡的狀態：在別處搬進資料夾，按「更新」取回', () => {
  test('既有的卡整批搬進一個環境之後，（無環境）不再出現，首頁導向那個環境', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-v31-'));
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const ws = makeWorkspace();
    gitInit(ws.corpus, remote);
    git(ws.corpus, 'push', '-q', '-u', 'origin', 'main');
    const h = await start(ws);
    cleanups.push(h.close);

    const ids = [
      await createCard(h, { type: 'original', title: '舊卡一' }),
      await createCard(h, { type: 'original', title: '舊卡二' }),
    ];
    await h.app.git.drain();
    assert.deepEqual(envNames((await h.app.fastify.inject('/')).body), ['*（無環境）']);

    // 在別處的 clone 把所有卡搬進「雜事與資料」，push。
    const other = path.join(dir, 'other');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
    fs.mkdirSync(path.join(other, 'cards', '雜事與資料'));
    for (const id of ids) git(other, 'mv', `cards/${id}.md`, `cards/雜事與資料/${id}.md`);
    git(other, 'commit', '-q', '-m', 'move into 雜事與資料');
    git(other, 'push', '-q', 'origin', 'main');

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.ok(res.body.includes('取回了 1 個 commit'));
    assert.ok(res.body.includes('2 / 2 張卡片進了索引'));
    assert.deepEqual(envNames(res.body), ['*雜事與資料'], '結果頁留在那個環境');
    for (const id of ids) assert.equal(h.app.index.getCard(id)?.env, '雜事與資料');

    const home = await h.app.fastify.inject('/');
    assert.equal(home.headers.location, `/e/${enc('雜事與資料')}/`);
  });
});

// ---------------------------------------------------------------- 側欄移除四份清單

describe('§3 側欄移除四份工作清單', () => {
  test('側欄不再列待思考、初步想法、雜筆、沉澱，那幾頁也不在了', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '一篇沒人接的文章' });
    const page = aside((await h.app.fastify.inject('/')).body);
    for (const name of ['待思考', '初步想法', '雜筆', '沉澱']) {
      assert.ok(!page.includes(name), `側欄還有「${name}」`);
    }
    for (const url of ['/pending', '/loose', '/fleeting', '/settling']) {
      assert.equal((await h.app.fastify.inject(url)).statusCode, 404, url);
    }
    assert.ok(!fs.existsSync(path.join('src', 'web', 'views', 'worklist.eta')));
  });

  test('首頁下面、追加外部資料上面是環境', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '一張' });
    const page = aside((await h.app.fastify.inject('/')).body);
    const at = (mark: string) => page.indexOf(mark);
    assert.ok(at('icon-home') < at('drawerenvs'));
    assert.ok(at('drawerenvs') < at('envgear'));
    assert.ok(at('envgear') < at('追加外部資料'));
  });
});

// ---------------------------------------------------------------- 介面調整

describe('§4 版面與配色', () => {
  const css = (name: string) => fs.readFileSync(path.join('public', 'css', `${name}.css`), 'utf8');

  test('側欄在 45rem 以上就常駐；有來源面板的分欄頁維持 60rem，把寬度留給兩欄', () => {
    const shell = css('shell');
    assert.match(shell, /@media \(min-width: 45rem\) \{\s*body:not\(:has\(\.split\)\) \{ padding-left: var\(--drawer-w\); \}/);
    assert.match(shell, /@media \(min-width: 60rem\) \{\s*body:has\(\.split\) \{ padding-left: var\(--drawer-w\); \}/);
  });

  test('窄的時候內容欄置中，不靠左', () => {
    assert.match(css('base'), /main \{[^}]*margin-inline: auto;/);
  });

  test('型別色彼此拉開：思考與產出的色差至少 0.2，任兩色至少 0.16（OKLab）', () => {
    const tokens = css('tokens');
    const color = (name: string) => {
      const m = new RegExp(`--type-${name}:\\s*(#[0-9A-Fa-f]{6});`).exec(tokens);
      assert.ok(m, name);
      return m[1] as string;
    };
    const names = ['original', 'restatement', 'thinking', 'output', 'fleeting'];
    const lab = Object.fromEntries(names.map((n) => [n, oklab(color(n))]));
    const d = (a: string, b: string) => Math.hypot(...[0, 1, 2].map((i) => (lab[a]![i]! - lab[b]![i]!)));
    assert.ok(d('thinking', 'output') >= 0.2, `思考與產出 ${d('thinking', 'output').toFixed(3)}`);
    for (const a of names) {
      for (const b of names) {
        if (a < b) assert.ok(d(a, b) >= 0.16, `${a}–${b} ${d(a, b).toFixed(3)}`);
      }
    }
  });
});

/** sRGB 十六進位 → OKLab。 */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
