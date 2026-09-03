import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { ReindexReport } from '../src/db.ts';
import { EPOCH } from '../src/id.ts';
import { W1_MESSAGE } from '../src/validate.ts';
import {
  countCards,
  createCard,
  gitInit,
  makeWorkspace,
  postCard,
  start,
  type Harness,
} from './helpers.ts';

/**
 * 這一組測試就是「做完了沒有」的定義。
 * 每一則對應一條驗收條件，順序與編號一致。
 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(withGit?: { remote?: string }): Promise<Harness> {
  const ws = makeWorkspace();
  if (withGit) gitInit(ws.corpus, withGit.remote);
  const h = await start(ws);
  cleanups.push(h.close);
  return h;
}

function cardFile(corpus: string, id: string): string {
  return path.join(corpus, 'cards', `${id}.md`);
}

describe('驗收條件', () => {
  test('1. 建立 original 卡片，頁面顯示標題與內文', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '恆星的能量來自核融合',
      body: '# 出處\n\n某本書第 12 頁。\n',
      tags: ['物理', '恆星'],
    });

    const page = await h.app.fastify.inject(`/c/${id}`);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('恆星的能量來自核融合'), '頁面應顯示標題');
    assert.ok(page.body.includes('某本書第 12 頁'), '頁面應顯示內文');
    assert.ok(fs.existsSync(cardFile(h.corpus, id)), '卡片檔案應存在');
  });

  test('2. 建立 restatement 卡片，帶一條 about 指向前一張', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: '我對原文的重述',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const raw = fs.readFileSync(cardFile(h.corpus, b), 'utf8');
    assert.ok(raw.includes('rel: about'), 'frontmatter 應有 about 連結');
    assert.ok(raw.includes(a), 'frontmatter 應指向前一張卡');
  });

  test('3. 被指向的卡片，反向連結區塊顯示來源卡片', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: '重述這張原文',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const page = await h.app.fastify.inject(`/c/${a}`);
    const back = page.body.slice(page.body.indexOf('class="stream down"'));
    assert.ok(back.includes('重述這張原文'), '被引用區塊應顯示來源卡片的標題');
    assert.ok(back.includes(`/c/${b}`), '被引用區塊應可點回來源卡片');
  });

  test('4. 連結指向不存在的 ID，400 且不產生任何檔案', async () => {
    const h = await fresh();
    const before = countCards(h.corpus);
    const res = await postCard(h, {
      type: 'thinking',
      title: '會被拒絕的卡',
      links: [{ rel: 'about', to: '1234567890123456789' }],
    });

    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { errors: string[] }).errors.join(), /不存在/);
    assert.equal(countCards(h.corpus), before, 'cards/ 下不應有新檔案');
  });

  test('5. 手工製造的壞連結，重建索引時被列出', async () => {
    const h = await fresh();
    const real = await createCard(h, { type: 'original', title: '真的存在', body: 'x' });

    // 一張 ID 比目標小的卡片：它的連結指向「未來」，違反連結只能指向過去。
    const olderId = (BigInt(real) - 1000n).toString();
    fs.writeFileSync(
      cardFile(h.corpus, olderId),
      [
        '---',
        `id: "${olderId}"`,
        'type: thinking',
        'created: "2026-09-03T00:00:00.000Z"',
        'title: 指向未來的壞卡',
        'tags: []',
        'url: null',
        'archive_url: null',
        'provenance: null',
        'revised: null',
        'links:',
        '  - rel: about',
        `    to: "${real}"`,
        '  - rel: supports',
        '    to: "1"',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await h.app.fastify.inject({ method: 'POST', url: '/_reindex' });
    assert.equal(res.statusCode, 200);
    const report = res.json() as ReindexReport;

    const order = report.bad_links.find((b) => b.reason === 'order');
    assert.ok(order, '報告應列出違反順序的連結');
    assert.equal(order.source_id, olderId);
    assert.equal(order.target_id, real);

    const missing = report.bad_links.find((b) => b.reason === 'missing');
    assert.ok(missing, '報告應列出指向不存在卡片的連結');
    assert.equal(missing.target_id, '1');
  });

  test('6. 刪掉索引後重啟，內容與重建前完全一致', async () => {
    const ws = makeWorkspace();
    const first = await start(ws);
    const a = await createCard(first, {
      type: 'original',
      title: '重建前後要一樣',
      body: '## 標題\n\n內文一段。',
      tags: ['甲', '乙'],
    });
    await createCard(first, {
      type: 'thinking',
      title: '引用上面那張',
      body: 'z',
      tags: ['甲'],
      links: [{ rel: 'supports', to: a }],
    });

    const snapshot = async (h: Harness) => ({
      feed: (await h.app.fastify.inject('/')).body,
      card: (await h.app.fastify.inject(`/c/${a}`)).body,
      tags: (await h.app.fastify.inject('/tags')).body,
      orphans: (await h.app.fastify.inject('/orphans')).body,
    });
    const before = await snapshot(first);
    await first.close();

    fs.rmSync(ws.indexPath, { force: true });
    assert.equal(fs.existsSync(ws.indexPath), false);

    const second = await start(ws);
    cleanups.push(second.close);
    const after2 = await snapshot(second);

    assert.deepEqual(after2, before, '重建後的每一頁都要與重建前逐字相同');
    assert.equal(second.app.index.countCards(), 2);
  });

  test('7. 建立後 30 秒內編輯，成功且 revised 有值', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '原標題', body: '原內文' });

    const res = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${id}`,
      payload: { title: '改過的標題', body: '改過的內文', tags: '新標籤' },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; revised: string };
    assert.equal(body.ok, true);
    assert.ok(Date.parse(body.revised) > 0, 'revised 應是合法時間');

    const raw = fs.readFileSync(cardFile(h.corpus, id), 'utf8');
    assert.ok(raw.includes('title: 改過的標題'));
    assert.ok(raw.includes('revised: "'));
    assert.ok((await h.app.fastify.inject(`/c/${id}`)).body.includes('改過的內文'));
  });

  test('8. 超過五分鐘的卡片不可編輯，403 並提示改用 updates', async () => {
    const h = await fresh();
    // 不等六分鐘，直接放一張六分鐘前建立的卡片檔進去，效果相同。
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    const id = ((BigInt(sixMinAgo) - EPOCH) << 22n).toString();
    fs.writeFileSync(
      cardFile(h.corpus, id),
      [
        '---',
        `id: "${id}"`,
        'type: thinking',
        `created: "${new Date(sixMinAgo).toISOString()}"`,
        'title: 六分鐘前寫的',
        'tags: []',
        'url: null',
        'archive_url: null',
        'provenance: null',
        'revised: null',
        'links: []',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${id}`,
      payload: { title: '想偷改' },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 403);
    assert.match((res.json() as { errors: string[] }).errors.join(), /updates/);

    await h.app.fastify.inject({ method: 'POST', url: '/_reindex' });
    const page = await h.app.fastify.inject(`/c/${id}`);
    assert.ok(!page.body.includes('/edit'), '鎖定後不應顯示編輯按鈕');
    assert.equal(
      fs.readFileSync(cardFile(h.corpus, id), 'utf8').includes('想偷改'),
      false,
      '檔案不應被改動',
    );
  });

  test('9. 沒有任何刪除卡片的途徑', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '刪不掉', body: 'x' });

    const routes = h.app.fastify.printRoutes({ commonPrefix: false });
    assert.ok(!routes.includes('DELETE'), `不應註冊任何 DELETE 路由：\n${routes}`);

    for (const url of [`/c/${id}`, '/admin', '/_delete', `/c/${id}/delete`]) {
      const res = await h.app.fastify.inject({ method: 'DELETE', url });
      assert.equal(res.statusCode, 404, `${url} 不應存在刪除途徑`);
    }
    assert.ok(fs.existsSync(cardFile(h.corpus, id)), '卡片檔案仍在');
  });

  test('10. git remote 壞掉時仍然寫入成功', async () => {
    const h = await fresh({ remote: '/nonexistent/definitely-not-a-repo.git' });

    const t0 = Date.now();
    const id = await createCard(h, {
      type: 'thinking',
      title: '斷線也要寫得進去',
      body: '寫入摩擦是這個系統唯一的生死線。',
    });
    const elapsed = Date.now() - t0;

    assert.ok(fs.existsSync(cardFile(h.corpus, id)), '卡片檔案應存在');
    assert.ok(elapsed < 300, `回應不應被 git 拖慢，實測 ${elapsed}ms`);

    await h.app.git.drain();
    const log = h.logs.join('\n');
    assert.match(log, /push failed/, 'log 應留下 push 失敗紀錄');
  });

  test('11. refutes 沒有附證據時顯示 W1 警告', async () => {
    const h = await fresh();
    const source = await createCard(h, { type: 'original', title: '被推翻的原文', body: 'x' });
    const id = await createCard(h, {
      type: 'thinking',
      title: '我認為那是錯的',
      body: 'y',
      links: [{ rel: 'refutes', to: source }],
    });

    const page = await h.app.fastify.inject(`/c/${id}`);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(W1_MESSAGE), 'W1 警告應顯示在卡片頁面上');

    // 補一條指向原始資料的依據之後，警告要消失。
    const withEvidence = await createCard(h, {
      type: 'thinking',
      title: '這次有附依據',
      body: 'z',
      links: [
        { rel: 'refutes', to: source },
        { rel: 'supports', to: source },
      ],
    });
    assert.ok(!(await h.app.fastify.inject(`/c/${withEvidence}`)).body.includes(W1_MESSAGE));
  });

  test('12. 200 張卡片後，首頁與搜尋仍在 300ms 內', async () => {
    const h = await fresh();
    for (let i = 0; i < 200; i += 1) {
      await createCard(h, {
        type: i % 3 === 0 ? 'thinking' : i % 3 === 1 ? 'restatement' : 'original',
        title: `第 ${i} 張卡片，關於近可分解性`,
        body: `內文 ${i}。`.repeat(20),
        tags: [`批次${i % 7}`, '效能'],
      });
    }
    assert.equal(countCards(h.corpus), 200);

    const timed = async (url: string) => {
      const t0 = performance.now();
      const res = await h.app.fastify.inject(url);
      assert.equal(res.statusCode, 200);
      return performance.now() - t0;
    };

    const feed = await timed('/');
    const search = await timed('/search?q=' + encodeURIComponent('近可分解性'));
    const tagged = await timed('/?tag=' + encodeURIComponent('效能'));

    assert.ok(feed < 300, `首頁 ${feed.toFixed(0)}ms`);
    assert.ok(search < 300, `搜尋 ${search.toFixed(0)}ms`);
    assert.ok(tagged < 300, `標籤篩選 ${tagged.toFixed(0)}ms`);
  });
});
