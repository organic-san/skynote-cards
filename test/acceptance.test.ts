import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import type { ReindexReport } from '../src/store/index/index.ts';
import { EPOCH } from '../src/domain/id.ts';
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
      pending: (await h.app.fastify.inject('/pending')).body,
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

  test('8. 反芻期關了就不可編輯，403 並提示改用 updates', async () => {
    // 「五分鐘」的界線被 R5 推翻：五分鐘只夠對齊字句，而一個衝動記下的東西
    // 需要一段窗口去補完還沒迭代完的內容。現在是 EDIT_WINDOW_HOURS，預設 8 小時。
    const h = await fresh();
    // 不等九小時，直接放一張九小時前建立的卡片檔進去，效果相同。
    const longAgo = Date.now() - 9 * 60 * 60 * 1000;
    const id = ((BigInt(longAgo) - EPOCH) << 22n).toString();
    fs.writeFileSync(
      cardFile(h.corpus, id),
      [
        '---',
        `id: "${id}"`,
        'type: thinking',
        `created: "${new Date(longAgo).toISOString()}"`,
        'title: 九小時前寫的',
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
    // D.5：定案的卡片什麼都不標——那是絕大多數卡片的狀態，標了等於在每一張卡上
    // 重複一句沒有訊息量的話。有話要說的是還改得動的那少數。
    assert.ok(!page.body.includes('尚可編輯'), '定案的卡片不掛反芻狀態');
    assert.equal(
      fs.readFileSync(cardFile(h.corpus, id), 'utf8').includes('想偷改'),
      false,
      '檔案不應被改動',
    );
  });

  test('8b. 被指向就立刻定案，不論反芻期是否結束', async () => {
    // R6：有人開始依賴你，你就定案了。這一條同時管住三件事——
    // 從待辦清單移出、關閉編輯、禁止刪除——所以它才值得取代「時間到就鎖」。
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: '剛寫的原文', body: 'x' });

    // 還在窗口內，改得動。
    const before = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${a}`,
      payload: { title: '改一次' },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(before.statusCode, 200, '沒人指向它的時候還改得動');

    // 有人指向它。時間一秒都沒有過去。
    await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const after = await h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${a}`,
      payload: { title: '再改一次' },
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(after.statusCode, 403, '被指向之後就改不動了');

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    assert.ok(!page.includes(`/c/${a}/edit`), '編輯按鈕要收起來');
    assert.ok(!page.includes('尚可編輯'), '定案的卡片不掛反芻狀態');

    // 同一個判準也把它移出「沉澱」清單。
    const page2 = (await h.app.fastify.inject('/settling')).body;
    // 側欄的卡片索引每一頁都在，會把每張卡的標題都印一次——要看的是清單本身。
    const settling = page2.slice(page2.indexOf('<main'), page2.indexOf('</main>'));
    // 用 ID 而不是標題來判斷：B 的 meta 行會把 about 目標（也就是 A）的標題
    // 印出來，拿標題比對會誤判成「A 還在清單裡」。
    assert.ok(!settling.includes(`/c/${a}`), '定案的卡片不再是「還可以動的東西」');
    assert.ok(settling.includes('B 重述 A'), '還沒被指向的 B 仍在清單裡');
  });

  test('9. 反芻期內、沒被指向的卡片可以刪除，其餘都不行', async () => {
    // v1 的「沒有任何刪除卡片的途徑」被推翻，因為 R7 讓連結只增不減：
    // 誤加一條就收不回，若連整張卡都不能刪，一次手滑會永久留在語料庫裡。
    // 刪除是 R7 的必要配套，不是方便功能。（spec G 節：I2 被 D 節修訂。）
    //
    // R6 保證被指向的卡片刪不掉，所以這條路徑永遠不會製造壞連結。
    // 要驗「刪除也走一次 commit」，所以這一份語料庫帶 git。
    const h = await fresh({});

    // ---- 剛建立、沒人指向：刪得掉。
    const gone = await createCard(h, { type: 'thinking', title: '手滑建的', body: 'x' });
    // 先讓建立的那次 commit 落地再刪——「刪除不等於抹除」的前提就是它已經
    // 被 commit 過。備份是 fire-and-forget，建立後幾毫秒內就刪掉的話兩次
    // git add 會一起撲空，那張卡等於從來沒有進過歷史。真實的反芻期有八小時，
    // 不會這樣，但這裡要驗的是留在歷史裡這件事，所以順序要對。
    await h.app.git.drain();
    const res = await h.app.fastify.inject({ method: 'DELETE', url: `/c/${gone}` });
    assert.equal(res.statusCode, 200);
    assert.ok(!fs.existsSync(cardFile(h.corpus, gone)), '檔案要消失');
    assert.equal((await h.app.fastify.inject(`/c/${gone}`)).statusCode, 404);
    assert.equal(h.app.index.getCard(gone), null, '索引也要拿掉');

    // 刪除不等於抹除：內容仍留在 git 歷史裡，這是備份該有的行為。
    await h.app.git.drain();
    const log = execFileSync('git', ['-C', h.corpus, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, new RegExp(`rm ${gone}`), '刪除也走一次 commit');
    assert.match(log, new RegExp(`add ${gone}`), '建立的那次 commit 還在歷史裡');

    // ---- 被指向：刪不掉，不論反芻期是否結束（R6）。
    const cited = await createCard(h, { type: 'original', title: '被引用的', body: 'y' });
    await createCard(h, {
      type: 'restatement',
      title: '重述它',
      body: 'z',
      links: [{ rel: 'about', to: cited }],
    });
    const blocked = await h.app.fastify.inject({ method: 'DELETE', url: `/c/${cited}` });
    assert.equal(blocked.statusCode, 403);
    assert.ok(fs.existsSync(cardFile(h.corpus, cited)), '被指向的卡片檔案還在');

    // ---- 不存在的 ID：404，不是 403。
    assert.equal(
      (await h.app.fastify.inject({ method: 'DELETE', url: '/c/99999999999999999' })).statusCode,
      404,
    );
  });

  test('9b. 反芻期關了就刪不掉', async () => {
    const h = await fresh();
    const longAgo = Date.now() - 9 * 60 * 60 * 1000;
    const id = ((BigInt(longAgo) - EPOCH) << 22n).toString();
    fs.writeFileSync(
      cardFile(h.corpus, id),
      ['---', `id: "${id}"`, 'type: thinking', `created: "${new Date(longAgo).toISOString()}"`,
       'title: 九小時前寫的', 'tags: []', 'url: null', 'archive_url: null',
       'provenance: null', 'revised: null', 'links: []', '---', '', 'body', ''].join('\n'),
      'utf8',
    );

    const res = await h.app.fastify.inject({ method: 'DELETE', url: `/c/${id}` });
    assert.equal(res.statusCode, 403);
    assert.match((res.json() as { errors: string[] }).errors.join(), /定案/);
    assert.ok(fs.existsSync(cardFile(h.corpus, id)), '檔案還在');
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

  test('12. 200 張卡片後，首頁與搜尋仍在 300ms 內', async () => {
    const h = await fresh();
    // 重述必須有原文可對照（R1），所以先鋪一張 original 給整批當靶。
    const source = await createCard(h, { type: 'original', title: '母文件', body: 'x' });
    for (let i = 0; i < 199; i += 1) {
      const type = i % 3 === 0 ? 'thinking' : i % 3 === 1 ? 'restatement' : 'original';
      await createCard(h, {
        type,
        title: `第 ${i} 張卡片，關於近可分解性`,
        body: `內文 ${i}。`.repeat(20),
        tags: [`批次${i % 7}`, '效能'],
        links: type === 'restatement' ? [{ rel: 'about', to: source }] : [],
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
