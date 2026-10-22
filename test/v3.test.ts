import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { readCard } from '../src/store/files.ts';
import { renderMarkdown, taskMarks } from '../src/web/render.ts';
import { setTaskMark, validateDraft } from '../src/domain/rules.ts';
import { CARD_ACTIONS, CARD_TYPES, allowedTargets } from '../src/domain/types.ts';
import { createCard, gitInit, makeWorkspace, start, type Harness } from './helpers.ts';

/** v3 規格（spec/Append_cards_v3_spec.md）各節的行為。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(opts: { editWindowMs?: number; git?: boolean } = {}): Promise<Harness> {
  const ws = makeWorkspace();
  if (opts.git) gitInit(ws.corpus);
  const h = await start({ ...ws, editWindowMs: opts.editWindowMs });
  cleanups.push(h.close);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function main(body: string): string {
  return body.slice(body.indexOf('<main>'), body.indexOf('</main>'));
}

function errorsOf(res: { json(): unknown }): string {
  return ((res.json() as { errors?: string[] }).errors ?? []).join(' | ');
}

/** 卡片頁上那一份 rev（R14 勾選帶回去比對用）。 */
async function cardRev(h: Harness, id: string): Promise<string> {
  const page = (await h.app.fastify.inject(`/c/${id}`)).body;
  return /class="body"[^>]*data-rev="([0-9a-f]+)"/.exec(page)?.[1] ?? '';
}

async function toggle(h: Harness, id: string, k: number | string, checked: unknown, rev: unknown) {
  return h.app.fastify.inject({
    method: 'POST',
    url: `/c/${id}/tasks/${k}`,
    payload: { checked, rev },
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
}

async function put(h: Harness, id: string, payload: Record<string, unknown>) {
  return h.app.fastify.inject({
    method: 'PUT',
    url: `/c/${id}`,
    payload,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
}

/** 手寫一張卡片檔，像是在別處改好、或在伺服器上直接放進去的。 */
function writeCardFile(
  corpus: string,
  card: { id: string; type: string; title: string; tags?: string[]; body?: string },
): void {
  fs.mkdirSync(path.join(corpus, 'cards'), { recursive: true });
  fs.writeFileSync(
    path.join(corpus, 'cards', `${card.id}.md`),
    [
      '---',
      `id: "${card.id}"`,
      `type: ${card.type}`,
      'created: "2026-09-03T00:00:00.000Z"',
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
      card.body ?? 'body',
      '',
    ].join('\n'),
    'utf8',
  );
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

// ---------------------------------------------------------------- §2 待辦勾選

describe('§2 待辦勾選（R14）', () => {
  test('清單項目開頭的 [ ] 與 [x] 畫成核取方塊，依出現順序編號', () => {
    const html = renderMarkdown('- [ ] 交作業\n- [x] 買車票\n1. [X] 編號清單也可以\n');
    assert.equal((html.match(/class="taskbox"/g) ?? []).length, 3);
    assert.match(html, /data-task="0" disabled>/);
    assert.match(html, /data-task="1" checked disabled>/);
    assert.match(html, /data-task="2" checked disabled>/, '[X] 與 [x] 同義');
    assert.match(html, /<li class="task">/);
    // 標記換成核取方塊，項目的文字還在。
    assert.ok(html.includes(' 交作業'));
    assert.ok(!html.includes('[ ]'));
  });

  test('不是標記的不畫：行首沒有清單記號、程式碼區塊、連結、緊接文字', () => {
    const src = [
      '[ ] 行首沒有清單記號',
      '',
      '```',
      '- [ ] 程式碼裡的',
      '```',
      '',
      '- [x](https://example.com) 是連結',
      '- [ ]沒有空白',
      '- 一般的項目 [ ] 在中間',
    ].join('\n');
    assert.ok(!renderMarkdown(src).includes('taskbox'));
    assert.deepEqual(taskMarks(src), []);
  });

  test('定位：第 k 個標記在原文裡的位置，跟畫面上的序號一致', () => {
    const src = [
      '前言',
      '',
      '- [ ] 一',
      '  - [x] 巢狀',
      '> - [ ] 引言裡的',
      '',
      '```',
      '- [ ] 不算',
      '```',
      '1. [ ] 編號',
      '',
    ].join('\n');
    const at = taskMarks(src);
    assert.equal(at.length, 4);
    for (const i of at) {
      assert.equal(src[i - 1], '[');
      assert.equal(src[i + 1], ']');
    }
    assert.deepEqual(at.map((i) => src[i]), [' ', 'x', ' ', ' ']);
    assert.equal((renderMarkdown(src).match(/class="taskbox"/g) ?? []).length, 4);

    // 碎片的文字可能帶著表單送來的 \r\n，位置照樣算得對。
    const crlf = src.replaceAll('\n', '\r\n');
    assert.deepEqual(taskMarks(crlf).map((i) => crlf[i]), [' ', 'x', ' ', ' ']);
  });

  test('setTaskMark 只換那一格；那一格不是標記就不寫', () => {
    assert.equal(setTaskMark('- [ ] a', 3, true), '- [x] a');
    assert.equal(setTaskMark('- [x] a', 3, false), '- [ ] a');
    assert.equal(setTaskMark('- [X] a', 3, true), '- [X] a', '已經是那個狀態就不動');
    assert.equal(setTaskMark('- [ ] a', 2, true), null, '那一格不是標記');
    assert.equal(setTaskMark('- [ ] a', -1, true), null);
  });

  test('卡片頁：核取方塊預設唯讀，頁面帶著 rev；來源面板停在唯讀', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '今天', body: '- [ ] 交作業\n- [x] 買車票' });

    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.match(page, /class="body" data-id="\d+" data-md="[^"]*" data-rev="[0-9a-f]{16}"/);
    assert.match(page, /data-task="0" disabled>/);
    assert.ok(page.includes('/static/js/tasks.js'), '只有卡片頁載入勾選的腳本');
    const js = fs.readFileSync(path.join('public', 'js', 'tasks.js'), 'utf8');
    assert.match(js, /box\.disabled = false/);

    const form = (await h.app.fastify.inject(`/new?type=thinking&rel=related&to=${id}`)).body;
    assert.ok(form.includes('class="taskbox"'), '來源面板照樣畫出來');
    assert.ok(!form.includes('tasks.js'), '但不給勾');
  });

  test('勾選只改那一個字元，不動 revised，交回新的 rev 與原文', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '今天', body: '- [ ] 交作業\n- [ ] 買車票\n' });
    const rev = await cardRev(h, id);

    const res = await toggle(h, id, 1, true, rev);
    assert.equal(res.statusCode, 200, errorsOf(res));
    const card = readCard(h.corpus, id);
    assert.equal(card.body, '- [ ] 交作業\n- [x] 買車票\n');
    assert.equal(card.revised, null, '勾選不是內容的修訂');

    const j = res.json() as { rev: string; md: string };
    assert.equal(j.md, '- [ ] 交作業\n- [x] 買車票', '複製與下載要拿到勾選之後的原文');
    assert.equal(j.rev, await cardRev(h, id), '交回的 rev 就是重新載入會拿到的那一個');
    assert.match(h.app.index.getCard(id)?.body ?? '', /\[x\] 買車票/, '索引跟著更新');

    // 勾回去也一樣。
    assert.equal((await toggle(h, id, 1, false, j.rev)).statusCode, 200);
    assert.equal(readCard(h.corpus, id).body, '- [ ] 交作業\n- [ ] 買車票\n');
  });

  test('頁面過期就 409：別處改過，序號可能已經指到別的項目', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '今天', body: '- [ ] 交作業\n- [ ] 買車票' });
    const rev = await cardRev(h, id);

    assert.equal((await toggle(h, id, 0, true, rev)).statusCode, 200, '另一個分頁先勾了');
    const stale = await toggle(h, id, 1, true, rev);
    assert.equal(stale.statusCode, 409);
    assert.ok(!readCard(h.corpus, id).body.includes('[x] 買車票'), '過期的請求不寫');
  });

  test('不受反芻期與定案限制', async () => {
    const h = await fresh({ editWindowMs: 1 });
    const done = await createCard(h, { type: 'thinking', title: '過期的', body: '- [ ] 一' });
    const cited = await createCard(h, { type: 'thinking', title: '被引用的', body: '- [ ] 二' });
    await createCard(h, {
      type: 'thinking',
      title: '引用它',
      body: 'x',
      links: [{ rel: 'supports', to: cited }],
    });
    await sleep(10);

    for (const id of [done, cited]) {
      assert.equal((await h.app.fastify.inject(`/c/${id}/edit`)).statusCode, 403, '編輯已經關了');
      const res = await toggle(h, id, 0, true, await cardRev(h, id));
      assert.equal(res.statusCode, 200, errorsOf(res));
    }
    assert.match(readCard(h.corpus, cited).body, /\[x\] 二/);
  });

  test('碎片也能勾：它的文字在 title（A.5）', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'fleeting', title: '- [ ] 買牛奶\n- [ ] 寄信', body: '' });
    const res = await toggle(h, id, 1, true, await cardRev(h, id));
    assert.equal(res.statusCode, 200, errorsOf(res));
    assert.equal(readCard(h.corpus, id).title, '- [ ] 買牛奶\n- [x] 寄信');
  });

  test('請求不合格就 400：序號不是整數、checked 不是布林、那裡沒有標記', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '今天', body: '- [ ] 一' });
    const rev = await cardRev(h, id);
    assert.equal((await toggle(h, id, 'x', true, rev)).statusCode, 400);
    assert.equal((await toggle(h, id, 0, 'yes', rev)).statusCode, 400);
    assert.equal((await toggle(h, id, 0, true, undefined)).statusCode, 400);
    assert.equal((await toggle(h, id, 5, true, rev)).statusCode, 400);
    assert.equal(readCard(h.corpus, id).body, '- [ ] 一\n');
  });

  test('commit 的動作是 check', async () => {
    const h = await fresh({ git: true });
    const id = await createCard(h, { type: 'thinking', title: '今天', body: '- [ ] 一' });
    // 等建立的那個 commit 做完：否則勾選寫檔時 add 還沒輪到，會被併進同一個 commit。
    await h.app.git.drain();
    assert.equal((await toggle(h, id, 0, true, await cardRev(h, id))).statusCode, 200);
    await h.app.git.drain();
    assert.match(git(h.corpus, 'log', '--oneline'), new RegExp(`check ${id}`));
  });

  test('編輯頁帶著 rev：別處存過就 409，不無聲蓋掉', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'output', title: '一篇', body: '第一版\n- [ ] 校對' });
    const edit = (await h.app.fastify.inject(`/c/${id}/edit`)).body;
    const rev = /id="editcard"[^>]*data-rev="([0-9a-f]+)"/.exec(edit)?.[1] ?? '';
    assert.notEqual(rev, '');

    // 另一台裝置先存了。
    assert.equal((await put(h, id, { body: '第二版', rev })).statusCode, 200);
    // 這一頁還拿著舊的。
    const stale = await put(h, id, { body: '舊的那頁', rev });
    assert.equal(stale.statusCode, 409);
    assert.match(errorsOf(stale), /別的地方改過/);
    assert.equal(readCard(h.corpus, id).body, '第二版\n');

    // 卡片頁上勾過也算別處改過。
    const id2 = await createCard(h, { type: 'output', title: '另一篇', body: '- [ ] 校對' });
    const rev2 =
      /data-rev="([0-9a-f]+)"/.exec((await h.app.fastify.inject(`/c/${id2}/edit`)).body)?.[1] ?? '';
    assert.equal((await toggle(h, id2, 0, true, await cardRev(h, id2))).statusCode, 200);
    assert.equal((await put(h, id2, { body: '- [ ] 校對\n補一段', rev: rev2 })).statusCode, 409);

    // 沒帶 rev 的請求（API、測試）不檢查。
    assert.equal((await put(h, id, { body: 'API 改的' })).statusCode, 200);

    const js = fs.readFileSync(path.join('public', 'js', 'editform.js'), 'utf8');
    assert.match(js, /rev: form\.dataset\.rev/);
  });
});

// ---------------------------------------------------------------- §3 產出

describe('§3 產出（R15）', () => {
  test('型別與關係矩陣', () => {
    assert.ok(CARD_TYPES.includes('output'));
    assert.deepEqual(allowedTargets('output', 'updates'), ['output']);
    assert.deepEqual([...(allowedTargets('output', 'related') ?? [])], [...CARD_TYPES], '取材對象不限型別');
    // 成品不提出命題。
    for (const rel of ['supports', 'refutes', 'contradicts', 'about', 'part-of'] as const) {
      assert.equal(allowedTargets('output', rel), null, `產出不能用 ${rel}`);
    }
    assert.ok(allowedTargets('thinking', 'about')?.includes('output'), '思考可以討論一份產出');
    for (const rel of ['supports', 'refutes', 'contradicts', 'updates'] as const) {
      assert.ok(!allowedTargets('thinking', rel)?.includes('output'), `思考不能 ${rel} 產出`);
    }
    assert.ok(!allowedTargets('restatement', 'about')?.includes('output'), 'R1：重述只錨定資料');
  });

  test('+ 選單：思考與碎片有「建立產出」，產出有發想與更新', async () => {
    for (const type of ['thinking', 'fleeting'] as const) {
      assert.ok(
        CARD_ACTIONS[type].some((a) => a.label === '建立產出' && a.creates === 'output' && a.rel === 'related'),
        `${type} 要有「建立產出」`,
      );
    }
    assert.deepEqual(
      CARD_ACTIONS.output.map((a) => [a.label, a.creates, a.rel]),
      [
        ['發想', 'thinking', 'about'],
        ['更新', 'output', 'updates'],
      ],
    );

    const h = await fresh();
    const idea = await createCard(h, { type: 'thinking', title: '一個想法', body: 'x', tags: ['故事'] });
    const page = (await h.app.fastify.inject(`/c/${idea}`)).body;
    const menu = page.slice(page.indexOf('id="fabmenu"'));
    assert.ok(menu.includes('建立產出'));

    // 按下去：表單說出它在做什麼，標籤繼承，連結預填成 related。
    const form = (await h.app.fastify.inject(`/new?type=output&rel=related&to=${idea}`)).body;
    assert.ok(form.includes('從《一個想法》的建立產出'));
    assert.match(form, /name="tags" autocomplete="off" placeholder="用空白分隔"\s+value="故事"/);
    assert.ok(form.includes('linkrow fixed rel-related'));
  });

  test('沒有來處的產出從隨手記展開：思考或產出二選一', async () => {
    const h = await fresh();
    const expanded = await h.app.fastify.inject({
      method: 'POST',
      url: '/quick',
      payload: new URLSearchParams({ body: '一篇短文的開頭', expand: '1' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const form = expanded.body;
    assert.ok(form.includes('<h1 class="formtitle">展開成思考或產出</h1>'));
    assert.match(form, /name="type" value="output" required >/, '產出可以選，不是預設');
    assert.ok(form.includes('<input type="hidden" name="entry" value="expand">'));
    assert.ok(form.includes('class="field" id="linksfield"'), '可以加連結');
    assert.ok(form.includes('class="field off" id="urlfield"'), '網址是資料專屬的');

    // 選產出送出：不需要標籤（R11 只管思考）。
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'output',
        title: '一篇短文',
        body: '一篇短文的開頭',
        tags: '',
        entry: 'expand',
        draft_scope: 'new:thinking:expand',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 302);
    const id = /\/c\/(\d+)/.exec(String(res.headers.location))?.[1] ?? '';
    assert.equal(readCard(h.corpus, id).type, 'output');
  });

  test('不設反芻期：過了期限仍可修改、加連結、刪除', async () => {
    const h = await fresh({ editWindowMs: 1 });
    const material = await createCard(h, { type: 'original', title: '材料', body: 'x' });
    const out = await createCard(h, { type: 'output', title: '初稿', body: '第一版' });
    const thought = await createCard(h, { type: 'thinking', title: '思考', body: 'x' });
    await sleep(10);

    assert.equal((await h.app.fastify.inject(`/c/${thought}/edit`)).statusCode, 403, '思考已經過期');
    assert.equal((await h.app.fastify.inject(`/c/${out}/edit`)).statusCode, 200, '產出照樣改得動');

    const res = await put(h, out, { body: '第二版', add_links: [{ rel: 'related', to: material }] });
    assert.equal(res.statusCode, 200, errorsOf(res));
    const card = readCard(h.corpus, out);
    assert.equal(card.body, '第二版\n');
    assert.deepEqual(card.links, [{ rel: 'related', to: material }]);

    // 卡片頁沒有倒數可說，但有編輯鈕；編輯頁說一次規則。
    const page = (await h.app.fastify.inject(`/c/${out}`)).body;
    assert.ok(!page.includes('尚可編輯'));
    assert.ok(page.includes(`href="/c/${out}/edit"`));
    const edit = (await h.app.fastify.inject(`/c/${out}/edit`)).body;
    assert.ok(edit.includes('被引用之前都可以修改'));
    assert.ok(!edit.includes('id="lock"'));

    const del = await h.app.fastify.inject({
      method: 'DELETE',
      url: `/c/${out}`,
      headers: { accept: 'application/json' },
    });
    assert.equal(del.statusCode, 200);
  });

  test('被引用就定案（R6），之後以新版本延續', async () => {
    const h = await fresh();
    const out = await createCard(h, { type: 'output', title: '成品', body: 'x' });
    await createCard(h, {
      type: 'thinking',
      title: '寫完之後的檢討',
      body: 'y',
      links: [{ rel: 'about', to: out }],
    });

    assert.equal((await h.app.fastify.inject(`/c/${out}/edit`)).statusCode, 403);
    assert.equal((await put(h, out, { body: '偷改' })).statusCode, 403);
    const del = await h.app.fastify.inject({ method: 'DELETE', url: `/c/${out}` });
    assert.equal(del.statusCode, 403);

    await createCard(h, { type: 'output', title: '成品 v2', body: 'z', links: [{ rel: 'updates', to: out }] });
  });

  test('沉澱不列產出：它沒有反芻期，列進來就永遠不會離開', async () => {
    const h = await fresh();
    await createCard(h, { type: 'output', title: '一份產出', body: 'x' });
    await createCard(h, { type: 'thinking', title: '一則思考', body: 'x' });
    const list = main((await h.app.fastify.inject('/settling')).body);
    assert.ok(list.includes('一則思考'));
    assert.ok(!list.includes('一份產出'));
  });

  test('列表上：色點、型別名、兩個方向的連結數；篩選列有它', async () => {
    const h = await fresh();
    await createCard(h, { type: 'output', title: '一篇文章', body: '開頭那幾個字' });
    const feed = main((await h.app.fastify.inject('/')).body);
    assert.ok(feed.includes('dot dot-output'));
    assert.match(feed, /<span class="tname">產出<\/span>\s*<span class="sep">·<\/span><span>出向 0 · 入向 0<\/span>/);
    assert.ok(feed.includes('開頭那幾個字'));
    assert.ok(feed.includes('href="/?type=output"'));

    const tokens = fs.readFileSync(path.join('public', 'css', 'tokens.css'), 'utf8');
    assert.match(tokens, /--type-output:\s*#[0-9A-Fa-f]{6};/);
    const base = fs.readFileSync(path.join('public', 'css', 'base.css'), 'utf8');
    assert.match(base, /\.dot-output\s*\{\s*background:\s*var\(--type-output\)/);
  });
});

// ---------------------------------------------------------------- §4 R11 與隨手記

describe('§4 思考需要標籤（R11）', () => {
  const deps = { cardExists: () => false, typeOf: () => null };
  const base = { title: 't', body: '', url: null, provenance: null, links: [] };

  test('思考至少要有一個標籤，其餘型別不強制', () => {
    assert.match(
      validateDraft({ ...base, type: 'thinking', tags: [] }, deps).errors.join(),
      /思考至少要有一個標籤/,
    );
    assert.deepEqual(validateDraft({ ...base, type: 'thinking', tags: ['x'] }, deps).errors, []);
    for (const type of ['original', 'output', 'fleeting']) {
      assert.deepEqual(validateDraft({ ...base, type, tags: [] }, deps).errors, [], type);
    }
  });

  test('唯一的標籤因為逗號被擋下來時，只報那一句', () => {
    const errors = validateDraft({ ...base, type: 'thinking', tags: ['乙，丙'] }, deps).errors;
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /逗號/);
  });

  test('修改視同建立：不能把思考的標籤刪到一個不剩', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: 't', body: 'x', tags: ['甲'] });
    const res = await put(h, id, { tags: '' });
    assert.equal(res.statusCode, 400);
    assert.match(errorsOf(res), /思考至少要有一個標籤/);
    assert.deepEqual(readCard(h.corpus, id).tags, ['甲']);
  });

  test('R11 之前寫的無標籤思考列入重建警告，不阻斷', async () => {
    const h = await fresh();
    const id = '88800000000000002';
    writeCardFile(h.corpus, { id, type: 'thinking', title: '沒有標籤的舊思考' });
    const report = (await h.app.fastify.inject({ method: 'POST', url: '/_reindex' })).json() as {
      warnings: { card_id: string; message: string }[];
    };
    assert.ok(report.warnings.some((w) => w.card_id === id && /標籤/.test(w.message)));
    assert.ok(h.app.index.getCard(id), '照樣進索引');
  });

  test('展開之後的型別按鈕，名字前面有色點', async () => {
    const h = await fresh();
    const form = (
      await h.app.fastify.inject({
        method: 'POST',
        url: '/quick',
        payload: new URLSearchParams({ body: 'x', expand: '1' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).body;
    const at = form.indexOf('class="typepick"');
    const pick = form.slice(at, form.indexOf('</div>', at));
    assert.match(pick, /<span><span class="dot dot-thinking"><\/span>思考<\/span>/);
    assert.match(pick, /<span><span class="dot dot-output"><\/span>產出<\/span>/);

    // 按鈕的框線只套外層那個 span：色點也是 span，不能跟著長出框線與內距。
    const css = fs.readFileSync(path.join('public', 'css', 'form.css'), 'utf8');
    assert.match(css, /\.typebtn > span\s*\{/);
    assert.ok(!/\.typebtn span\s*\{/.test(css));
  });

  test('隨手記展開成思考：標籤欄在那裡，沒有標籤送不出去，退回時仍可改選產出', async () => {
    const h = await fresh();
    const expanded = await h.app.fastify.inject({
      method: 'POST',
      url: '/quick',
      payload: new URLSearchParams({ body: '寫到一半', expand: '1' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.ok(expanded.body.includes('class="field" id="tagsfield"'), '完整表單有標籤欄');

    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'thinking',
        title: '展開後',
        body: '寫到一半',
        tags: '',
        entry: 'expand',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.includes('思考至少要有一個標籤'));
    assert.equal(h.app.index.countCards(), 0);
    // 被擋下來時，改成產出是一條出路，所以退回的表單照樣二選一。
    assert.ok(res.body.includes('<h1 class="formtitle">展開成思考或產出</h1>'));
    assert.match(res.body, /value="thinking" required checked/);
    assert.match(res.body, /value="output" required >/);
  });
});

// ---------------------------------------------------------------- §5 側欄下半

describe('§5 側欄下半依頁面切換', () => {
  const aside = (body: string) => body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));

  test('文章一覽列最近的標籤，不列卡片', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '一張思考', body: '關鍵字', tags: ['主題'] });
    for (const url of ['/', `/search?q=${encodeURIComponent('關鍵字')}`, '/settling', '/tags']) {
      const side = aside((await h.app.fastify.inject(url)).body);
      assert.ok(side.includes('class="sidetags"'), `${url} 要列最近的標籤`);
      assert.ok(!side.includes('class="sidecards"'), `${url} 不列卡片`);
      assert.ok(!side.includes('一張思考'));
    }
  });

  test('卡片頁與編輯介面列最近的卡片，正在看或正在改的那一張標起來', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '較早的資料', body: 'x' });
    const id = await createCard(h, { type: 'thinking', title: '正在看的', body: 'x', tags: ['主題'] });

    const pages: [string, string | null][] = [
      [`/c/${id}`, id],
      [`/c/${id}/edit`, id],
      ['/new?type=original', null],
    ];
    for (const [url, active] of pages) {
      const side = aside((await h.app.fastify.inject(url)).body);
      assert.ok(side.includes('class="indexhead">最近的卡片<'), `${url} 要列最近的卡片`);
      assert.ok(!side.includes('class="sidetags"'), `${url} 不列標籤`);
      assert.ok(side.includes('較早的資料') && side.includes('正在看的'));
      // 型別靠色點，不放型別名：這一欄很窄，標題本來就在截斷邊緣。
      assert.ok(side.includes('dot dot-original') && !side.includes('tname'));
      if (active) assert.ok(side.includes(`href="/c/${active}" class="on"`), `${url} 要標出這一張`);
      else assert.ok(!side.includes('class="on"'));
    }

    // 隨手記展開之後也是寫卡的地方。
    const expanded = await h.app.fastify.inject({
      method: 'POST',
      url: '/quick',
      payload: new URLSearchParams({ body: '寫到一半', expand: '1' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.ok(aside(expanded.body).includes('class="sidecards"'));

    // 13px 的文字配小一號的色點：改寫容器上的 --dot，整組跟著縮。
    const css = fs.readFileSync(path.join('public', 'css', 'shell.css'), 'utf8');
    assert.match(css, /\.sidecards,\s*\.sidetags\s*\{[^}]*--dot:\s*var\(--dot-sm\)/);
    assert.match(fs.readFileSync(path.join('public', 'css', 'tokens.css'), 'utf8'), /--dot-sm:\s*6px/);
  });
});

// ---------------------------------------------------------------- §6.1 下載

describe('§6.1 Markdown 檔下載', () => {
  test('卡片頁有下載鈕：標題當檔名，碎片用 ID', async () => {
    const h = await fresh();
    // 檔名不允許的字元交給瀏覽器替換，伺服器不改。
    const t = await createCard(h, { type: 'thinking', title: 'A/B 測試', body: 'x' });
    const page = (await h.app.fastify.inject(`/c/${t}`)).body;
    assert.match(page, /id="dlbtn"[^>]*data-file="A\/B 測試\.md"/);
    assert.match(page, /class="body"[^>]*data-title="A\/B 測試"/);

    const f = await createCard(h, { type: 'fleeting', title: '一句話', body: '' });
    const fp = (await h.app.fastify.inject(`/c/${f}`)).body;
    assert.match(fp, new RegExp(`id="dlbtn"[^>]*data-file="${f}\\.md"`));
    assert.ok(!/class="body"[^>]*data-title=/.test(fp), '碎片沒有標題');

    const js = fs.readFileSync(path.join('public', 'js', 'download.js'), 'utf8');
    assert.match(js, /'# ' \+ title \+ '\\n\\n' \+ md/, '`# 標題`、一個空行、內文');
    assert.match(js, /body\.dataset\.md/, '原文跟複製鈕讀同一個地方');
    const css = fs.readFileSync(path.join('public', 'css', 'card.css'), 'utf8');
    assert.match(css, /html:not\(\.js\) \.toolbtn \{ display: none; \}/, '沒有 JS 就不畫');
  });
});

// ---------------------------------------------------------------- §7 更新

describe('§7 側欄「更新」', () => {
  test('沒有 git：只重建索引，直接在伺服器上改的檔也看得到', async () => {
    const h = await fresh();
    const id = '88800000000000003';
    writeCardFile(h.corpus, { id, type: 'original', title: '直接放進去的' });
    assert.equal(h.app.index.getCard(id), null);

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('不是 git repository'));
    assert.ok(res.body.includes('1 / 1 張卡片進了索引'));
    assert.ok(h.app.index.getCard(id));
  });

  test('沒有 remote：一樣只重建索引', async () => {
    const h = await fresh({ git: true });
    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('沒有設定 remote'));
    assert.ok(res.body.includes('張卡片進了索引'));
  });

  test('GET 不會觸發更新', async () => {
    const h = await fresh();
    assert.equal((await h.app.fastify.inject('/update')).statusCode, 404);
  });

  /** 一個 bare remote、伺服器上的語料庫、別處的一份 clone。 */
  async function withRemote() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'append-cards-remote-'));
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const ws = makeWorkspace();
    gitInit(ws.corpus, remote);
    git(ws.corpus, 'push', '-q', '-u', 'origin', 'main');
    const h = await start(ws);
    cleanups.push(h.close);
    await h.app.git.drain();

    const other = path.join(dir, 'other');
    execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
    return { h, other };
  }

  test('取回別處推上去的卡片，再重建索引', async () => {
    const { h, other } = await withRemote();
    const id = '88800000000000004';
    writeCardFile(other, { id, type: 'original', title: '在別處改好的' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', `add ${id}`);
    git(other, 'push', '-q', 'origin', 'main');

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('取回了 1 個 commit'), res.body.slice(res.body.indexOf('<main>')));
    assert.ok(res.body.includes(`add ${id}`), '列出取回的 commit');
    assert.ok(fs.existsSync(path.join(h.corpus, 'cards', `${id}.md`)));
    assert.ok(h.app.index.getCard(id), '索引重建過了');

    // 再按一次：已是最新。
    const again = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.ok(again.body.includes('已是最新'));
  });

  test('本機還沒推上去的 commit 接在取回的後面再推上去，但不算「取回的」', async () => {
    const { h, other } = await withRemote();
    // 伺服器上積著一個還沒推上去的 commit（例如先前 push 失敗）。
    const local = '88800000000000005';
    writeCardFile(h.corpus, { id: local, type: 'original', title: '本機的' });
    git(h.corpus, 'add', '-A', 'cards');
    git(h.corpus, 'commit', '-q', '-m', `add ${local}`);
    // 別處推了另一張。
    const remote = '88800000000000006';
    writeCardFile(other, { id: remote, type: 'original', title: '遠端的' });
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', `add ${remote}`);
    git(other, 'push', '-q', 'origin', 'main');

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.ok(res.body.includes('取回了 1 個 commit'), res.body.slice(res.body.indexOf('<main>')));
    assert.ok(res.body.includes(`add ${remote}`));
    assert.ok(!res.body.includes(`add ${local}`), 'rebase 重寫過的本機 commit 不是取回來的');

    // 兩張都在，本機那個也推上去了。
    assert.ok(h.app.index.getCard(local) && h.app.index.getCard(remote));
    git(other, 'pull', '-q', 'origin', 'main');
    assert.match(git(other, 'log', '--oneline', '-1'), new RegExp(`add ${local}`));
  });

  test('衝突就放棄這次取回，語料庫回到原狀', async () => {
    const { h, other } = await withRemote();
    const id = await createCard(h, { type: 'thinking', title: '兩邊都改了', body: '原本的', tags: ['甲'] });
    await h.app.git.drain();

    // 別處先改、先推上去。
    git(other, 'pull', '-q', 'origin', 'main');
    const file = path.join(other, 'cards', `${id}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('原本的', '別處改的'), 'utf8');
    git(other, 'commit', '-q', '-am', `edit ${id}`);
    git(other, 'push', '-q', 'origin', 'main');

    // 伺服器上也改了同一張（push 會被拒絕，commit 留在本機）。
    assert.equal((await put(h, id, { body: '伺服器上改的' })).statusCode, 200);
    await h.app.git.drain();

    const res = await h.app.fastify.inject({ method: 'POST', url: '/update' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('有衝突'), res.body.slice(res.body.indexOf('<main>')));
    assert.ok(res.body.includes(`cards/${id}.md`), '列出衝突的檔案');
    assert.ok(!res.body.includes('張卡片進了索引'), '語料庫沒有變，不重建');

    assert.equal(readCard(h.corpus, id).body, '伺服器上改的\n', '語料庫回到取回之前');
    assert.equal(
      git(h.corpus, 'status', '--porcelain', '--untracked-files=no'),
      '',
      '沒有停在 rebase 的一半',
    );
    assert.ok(!fs.existsSync(path.join(h.corpus, '.git', 'rebase-merge')));
  });
});
