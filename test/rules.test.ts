import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseCard, serializeCard } from '../src/cardfile.ts';
import { renderMarkdown } from '../src/render.ts';
import { compareIds, generateId } from '../src/id.ts';
import type { Card } from '../src/types.ts';
import { computeW1, validateDraft, validateLinkOrder } from '../src/validate.ts';
import { embedFor } from '../src/embed.ts';
import { ftsQuery, segmentCjk } from '../src/db.ts';
import { execFileSync } from 'node:child_process';
import { createCard, gitInit, makeWorkspace, postCard, start, type Harness } from './helpers.ts';

/** 撐住整份規則的幾個小零件，以及頁面能不能渲染出來。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(): Promise<Harness> {
  const h = await start(makeWorkspace());
  cleanups.push(h.close);
  return h;
}

describe('ID', () => {
  test('同一毫秒內連續產生的 ID 依先後遞增', () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i += 1) ids.push(generateId());
    for (let i = 1; i < ids.length; i += 1) {
      assert.equal(compareIds(ids[i - 1]!, ids[i]!), -1, `第 ${i} 個 ID 沒有變大`);
    }
    assert.equal(new Set(ids).size, ids.length, 'ID 不得重複');
  });

  test('比較用數值不用字串', () => {
    assert.equal(compareIds('9999999999999999', '10000000000000000'), -1);
  });

  test('檔名已被佔用時會重抽', () => {
    const used = new Set<string>();
    const first = generateId();
    used.add(first);
    const second = generateId((id) => used.has(id));
    assert.notEqual(second, first);
  });
});

describe('卡片檔案', () => {
  const card: Card = {
    id: '1234567890123456789',
    type: 'thinking',
    created: '2026-09-03T14:32:11.482Z',
    title: '標題裡有: 冒號、逗號，還有 #井字',
    tags: ['物理', '複雜系統', 'a,b'],
    url: 'https://example.com/x',
    provenance: null,
    revised: null,
    links: [
      { rel: 'about', to: '1234567890111111111' },
      { rel: 'refutes', to: '1234567890222222222' },
    ],
    body: '內文。\n\n- 一\n- 二\n',
  };

  test('序列化後再解析，內容完全相同', () => {
    const parsed = parseCard(serializeCard(card), card.id);
    assert.deepEqual(parsed, card);
  });

  test('id 與 created 一定帶引號，不會被解析成數字或時間', () => {
    const text = serializeCard(card);
    assert.ok(text.includes('id: "1234567890123456789"'));
    assert.ok(text.includes('created: "2026-09-03T14:32:11.482Z"'));
    assert.ok(text.includes('to: "1234567890111111111"'));
  });

  test('空標籤與空連結寫成空陣列', () => {
    const text = serializeCard({ ...card, tags: [], links: [] });
    assert.ok(text.includes('tags: []'));
    assert.ok(text.includes('links: []'));
  });
});

describe('驗證規則', () => {
  const deps = { cardExists: (id: string) => id === '100' };

  test('type 必須是三個合法值之一', () => {
    assert.match(
      validateDraft({ type: 'note', title: 't', body: '', tags: [], url: null, provenance: null, links: [] }, deps).errors.join(),
      /未選類型/,
    );
  });

  test('title trim 後不得為空', () => {
    assert.match(
      validateDraft({ type: 'thinking', title: '   ', body: '', tags: [], url: null, provenance: null, links: [] }, deps).errors.join(),
      /標題不得為空/,
    );
  });

  test('標籤去重但不做任何正規化', () => {
    const r = validateDraft(
      { type: 'thinking', title: 't', body: '', tags: ['ML', 'ml', 'ML'], url: null, provenance: null, links: [] },
      deps,
    );
    assert.deepEqual(r.value?.tags, ['ML', 'ml']);
  });

  test('rel 不在詞彙表內就拒絕', () => {
    assert.match(
      validateDraft({ type: 'thinking', title: 't', body: '', tags: [], url: null, provenance: null, links: [{ rel: 'inspires', to: '100' }] }, deps).errors.join(),
      /不在詞彙表內/,
    );
  });

  test('同 rel 同目標的連結不得重複', () => {
    assert.match(
      validateDraft({ type: 'thinking', title: 't', body: '', tags: [], url: null, provenance: null, links: [{ rel: 'about', to: '100' }, { rel: 'about', to: '100' }] }, deps).errors.join(),
      /重複/,
    );
  });

  test('provenance 是 original 專屬，其他類型送了也只是被丟掉', () => {
    const other = validateDraft(
      { type: 'thinking', title: 't', body: '', tags: [], url: null, provenance: 'translated', links: [] },
      deps,
    );
    assert.deepEqual(other.errors, [], '不該因為夾帶 provenance 就整筆退回');
    assert.equal(other.value?.provenance, null, 'provenance 不該寫進非 original 的卡片');

    const ok = validateDraft(
      { type: 'original', title: 't', body: '', tags: [], url: null, provenance: null, links: [] },
      deps,
    );
    assert.equal(ok.value?.provenance, 'default');
  });

  test('連結不得指向比自己大或等於自己的 ID', () => {
    assert.equal(validateLinkOrder('200', [{ rel: 'about', to: '100' }]).length, 0);
    assert.equal(validateLinkOrder('200', [{ rel: 'about', to: '200' }]).length, 1);
    assert.equal(validateLinkOrder('200', [{ rel: 'about', to: '300' }]).length, 1);
  });
});

describe('W1', () => {
  const typeOf = (id: string) => ({ o: 'original', e: 'restatement', t: 'thinking' })[id] ?? null;

  test('沒有推翻或取代就不警告', () => {
    assert.equal(computeW1([{ rel: 'about', to: 'o' }], typeOf), false);
  });

  test('只有 refutes 本身時警告', () => {
    assert.equal(computeW1([{ rel: 'refutes', to: 'o' }], typeOf), true);
  });

  test('另外附上指向原始資料或重述的連結就不警告', () => {
    assert.equal(computeW1([{ rel: 'refutes', to: 'o' }, { rel: 'supports', to: 'e' }], typeOf), false);
  });

  test('附的依據若是另一張思考卡，仍然警告', () => {
    assert.equal(computeW1([{ rel: 'updates', to: 't' }, { rel: 'related', to: 't' }], typeOf), true);
  });
});

describe('頁面與端點', () => {
  test('建立表單有三個類型、六種 rel、以及收合的選填欄位', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject('/new');
    assert.equal(res.statusCode, 200);
    for (const t of ['original', 'restatement', 'thinking']) {
      assert.ok(res.body.includes(`value="${t}"`), `缺少類型 ${t}`);
    }
    for (const r of ['about', 'related', 'supports', 'contradicts', 'refutes', 'updates']) {
      assert.ok(res.body.includes(`value="${r}"`), `缺少 rel 選項 ${r}`);
    }
    assert.ok(res.body.includes('<details'), '選填欄位應預設收合');
    assert.ok(res.body.includes('/static/new.js'));
  });

  test('連結選擇器同時吃 ID 與標題', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '近可分解性', body: 'x' });

    const byTitle = await h.app.fastify.inject('/api/search?q=' + encodeURIComponent('可分解'));
    assert.deepEqual(
      (byTitle.json() as { id: string }[]).map((r) => r.id),
      [id],
    );

    const byId = await h.app.fastify.inject(`/api/search?q=${id}`);
    assert.equal((byId.json() as { id: string }[])[0]?.id, id);

    const empty = await h.app.fastify.inject('/api/search?q=');
    assert.deepEqual(empty.json(), []);
  });

  test('表單送出（urlencoded）與 JSON 送出等價', async () => {
    const h = await fresh();
    const target = await createCard(h, { type: 'original', title: '目標', body: 'x' });
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'restatement',
        title: '用表單送出的卡',
        body: '內文',
        tags: '甲, 乙 丙',
        link_rel: 'about',
        link_to: target,
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 302);
    const loc = res.headers.location as string;
    const page = await h.app.fastify.inject(loc);
    assert.ok(page.body.includes('用表單送出的卡'));
    for (const t of ['甲', '乙', '丙']) assert.ok(page.body.includes(`>#${t}</a>`), `標籤 ${t} 沒切出來`);
  });

  test('驗證失敗時表單原樣退回並列出錯誤', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({ type: 'thinking', title: '', body: '寫了一半的內文' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.includes('標題不得為空'));
    assert.ok(res.body.includes('寫了一半的內文'), '已經打好的內文不該消失');
  });

  test('編輯頁在時窗內可開，並帶著鎖定時間', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '可編輯', body: 'x' });
    const res = await h.app.fastify.inject(`/c/${id}/edit`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /data-until="20\d\d-/);
  });

  test('內文的原始 HTML 會被跳脫', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'thinking',
      title: 'XSS',
      body: '<script>alert(1)</script>\n\n[點我](javascript:alert(2))',
    });
    const page = await h.app.fastify.inject(`/c/${id}`);
    assert.ok(!page.body.includes('<script>alert(1)</script>'));
    assert.ok(!page.body.includes('href="javascript:'));
  });

  test('外部 url 只接受 http 與 https', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '外部連結',
      body: 'x',
      url: 'javascript:alert(1)',
    });
    const page = await h.app.fastify.inject(`/c/${id}`);
    assert.ok(!page.body.includes('javascript:alert'));
  });

  test('健康檢查回報檔案數與索引筆數', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '一', body: 'x' });
    const res = await h.app.fastify.inject('/_health');
    const j = res.json() as { cards_files: number; cards_indexed: number };
    assert.equal(j.cards_files, 1);
    assert.equal(j.cards_indexed, 1);
  });

  test('重建索引是冪等的', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '一', body: 'x', tags: ['甲'] });
    const before = (await h.app.fastify.inject('/')).body;
    for (let i = 0; i < 3; i += 1) {
      const r = await h.app.fastify.inject({ method: 'POST', url: '/_reindex' });
      assert.equal(r.statusCode, 200);
    }
    assert.equal((await h.app.fastify.inject('/')).body, before);
  });

  test('靜態檔案掛得起來', async () => {
    const h = await fresh();
    const css = await h.app.fastify.inject('/static/style.css');
    assert.equal(css.statusCode, 200);
    const js = await h.app.fastify.inject('/static/new.js');
    assert.equal(js.statusCode, 200);
  });

  test('分頁一頁 50 筆', async () => {
    const h = await fresh();
    for (let i = 0; i < 55; i += 1) {
      await createCard(h, { type: 'thinking', title: `第 ${i} 張`, body: 'x' });
    }
    const p1 = await h.app.fastify.inject('/');
    const p2 = await h.app.fastify.inject('/?page=2');
    const count = (s: string) => (s.match(/<li class="row">/g) ?? []).length;
    assert.equal(count(p1.body), 50);
    assert.equal(count(p2.body), 5);
  });
});

describe('語料庫的樣子', () => {
  test('卡片檔就是可讀的 markdown，沒有其他東西被寫進去', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '一疊 markdown',
      body: '# 標題\n\n內文。\n',
      tags: ['存檔'],
    });
    const dir = path.join(h.corpus, 'cards');
    assert.deepEqual(fs.readdirSync(dir), [`${id}.md`]);
    const text = fs.readFileSync(path.join(dir, `${id}.md`), 'utf8');
    assert.ok(text.startsWith('---\n'));
    assert.ok(text.includes('\n# 標題\n'));
  });

  test('被拒絕的請求不會留下暫存檔', async () => {
    const h = await fresh();
    await postCard(h, { type: 'thinking', title: '', body: 'x' });
    assert.deepEqual(fs.readdirSync(path.join(h.corpus, 'cards')), []);
  });
});

describe('備份', () => {
  test('啟動時補上只有檔案、沒有 commit 的卡片', async () => {
    const ws = makeWorkspace();
    gitInit(ws.corpus);

    // 行程在 commit 排進佇列之前被中斷，語料庫裡就會留下這種檔案。
    const id = '88800000000000001';
    fs.writeFileSync(
      path.join(ws.corpus, 'cards', `${id}.md`),
      ['---', `id: "${id}"`, 'type: thinking', 'created: "2026-09-03T00:00:00.000Z"',
       'title: 沒被 commit 的卡', 'tags: []', 'url: null', 'archive_url: null',
       'provenance: null', 'revised: null', 'links: []', '---', '', 'body', ''].join('\n'),
      'utf8',
    );

    const h = await start(ws);
    cleanups.push(h.close);
    await h.app.git.drain();

    const log = execFileSync('git', ['-C', ws.corpus, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, new RegExp(`add ${id}`), '啟動時應該補上這張卡的 commit');
  });
});

describe('介面', () => {
  test('每一頁都有左側選單，卡片頁與時間軸有新增鈕', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '一', body: 'x' });

    for (const url of ['/', '/tags', '/orphans', `/c/${id}`]) {
      const res = await h.app.fastify.inject(url);
      assert.ok(res.body.includes('id="drawer"'), `${url} 應有左側選單`);
      assert.ok(res.body.includes('id="fab"'), `${url} 應有新增鈕`);
    }
    // 表單頁不該再冒出一顆新增鈕。
    assert.ok(!(await h.app.fastify.inject('/new')).body.includes('id="fab"'));
    assert.ok(!(await h.app.fastify.inject(`/c/${id}/edit`)).body.includes('id="fab"'));
  });

  test('時間軸列有內文開頭', async () => {
    const h = await fresh();
    await createCard(h, {
      type: 'thinking',
      title: '標題',
      body: '# 小標\n\n這一段會出現在列表上。',
    });
    const res = await h.app.fastify.inject('/');
    assert.ok(res.body.includes('這一段會出現在列表上。'), '列表應顯示內文開頭');
    assert.ok(!res.body.includes('# 小標'), 'markdown 記號不該漏出來');
  });

  test('從時間軸開新卡三種類型都能選', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject('/');
    for (const t of ['original', 'restatement', 'thinking']) {
      assert.ok(res.body.includes(`/new?type=${t}"`), `選單缺少 ${t}`);
    }
  });

  test('從卡片開新卡不給 original，且預先連上那張卡', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '被回應的原文', body: 'x' });

    // 屬性裡的 & 會被跳脫成 &amp;，比對前還原回來。
    const card = (await h.app.fastify.inject(`/c/${id}`)).body.replaceAll('&amp;', '&');
    assert.ok(!card.includes(`/new?type=original&to=${id}`), '不該出現 original 選項');
    for (const t of ['restatement', 'thinking']) {
      assert.ok(card.includes(`/new?type=${t}&to=${id}`), `選單缺少 ${t}`);
    }

    const form = await h.app.fastify.inject(`/new?type=thinking&to=${id}`);
    assert.ok(form.body.includes(`value="${id}"`), '連結目標應預先填好');
    assert.ok(form.body.includes('被回應的原文'), '應顯示目標卡片的標題');
    assert.ok(form.body.includes('value="thinking" required checked'), '類型應該預先選好');
    assert.ok(!form.body.includes('value="original"'), '不該給 original 選項');
  });

  test('帶著 to 又指定 original 時，退回類型選擇', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '目標', body: 'x' });
    const form = await h.app.fastify.inject(`/new?type=original&to=${id}`);
    assert.ok(!form.body.includes('required checked'), '不該替使用者選好類型');
    assert.ok(!form.body.includes('value="original"'), '不該給 original 選項');
  });

  test('引用串是多層的，重複出現的節點只展開一次', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });
    const c = await createCard(h, {
      type: 'thinking',
      title: 'C 同時引用 A 與 B',
      body: 'z',
      links: [
        { rel: 'refutes', to: a },
        { rel: 'supports', to: b },
      ],
    });

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    const cited = page.slice(page.indexOf('class="stream down"'));

    assert.ok(cited.includes('B 重述 A'), '直接引用要在');
    assert.ok(cited.includes('C 同時引用 A 與 B'), '間接引用也要在');
    assert.ok(cited.includes('rel-about'), '縮排線要帶著關係');
    assert.ok(cited.includes('rel-refutes'));
    // C 從 refutes 那一支先展開，再從 B 底下遇到時只留一行。
    assert.ok(cited.includes('上方已展開'), '重複出現的節點要標出來');
    assert.equal(cited.split(`/c/${c}`).length - 1, 2, 'C 應該正好出現兩次');
  });

  test('出向連結也能往回追一層以上', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });
    const c = await createCard(h, {
      type: 'thinking',
      title: 'C 引用 B',
      body: 'z',
      links: [{ rel: 'supports', to: b }],
    });

    const page = (await h.app.fastify.inject(`/c/${c}`)).body;
    const refs = page.slice(page.indexOf('class="stream up"'), page.indexOf('<article'));
    assert.ok(refs.includes('B 重述 A'));
    assert.ok(refs.includes('A 原文'), '依賴鏈要能一路追到底');
  });
});

describe('外部 url 的內嵌', () => {
  test('YouTube 的三種網址都認得，而且走 nocookie', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      const e = embedFor(u);
      assert.equal(e?.kind, 'youtube', u);
      assert.equal(e?.src, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    }
    assert.equal(
      embedFor('https://youtu.be/dQw4w9WgXcQ?t=90')?.src,
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
    );
  });

  test('圖片與 PDF 直接嵌，其他一律不嵌', () => {
    assert.equal(embedFor('https://example.com/a.png')?.kind, 'image');
    assert.equal(embedFor('https://example.com/a.pdf')?.kind, 'pdf');
    assert.equal(embedFor('https://x.com/someone/status/123'), null);
    assert.equal(embedFor('https://example.com/article'), null);
  });

  test('非 https 一律不嵌', () => {
    assert.equal(embedFor('http://example.com/a.png'), null);
    assert.equal(embedFor('javascript:alert(1)'), null);
    assert.equal(embedFor(null), null);
  });

  test('卡片頁把 YouTube 放成 iframe，認不出來的只留連結', async () => {
    const h = await fresh();
    const yt = await createCard(h, {
      type: 'original',
      title: '一支影片',
      body: 'x',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    const page = (await h.app.fastify.inject(`/c/${yt}`)).body;
    assert.ok(page.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));
    assert.ok(page.includes('<iframe'));
    assert.ok(!page.includes('platform.twitter.com'), '不該載入任何第三方腳本');

    const plain = await createCard(h, {
      type: 'original',
      title: '一篇文章',
      body: 'x',
      url: 'https://example.com/article',
    });
    const page2 = (await h.app.fastify.inject(`/c/${plain}`)).body;
    assert.ok(!page2.includes('<iframe'));
    assert.ok(page2.includes('https://example.com/article'));
  });
});

describe('側欄', () => {
  test('順序是導覽、搜尋、最近卡片、建立卡片', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '最近寫的一張', body: 'x' });
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));

    const order = ['drawernav', 'drawersearch', 'recent', 'drawernew'];
    let at = -1;
    for (const cls of order) {
      const next = aside.indexOf(cls);
      assert.ok(next > at, `${cls} 的位置不對`);
      at = next;
    }
    assert.ok(aside.includes('最近寫的一張'), '最近卡片要列在側欄');
    assert.ok(aside.includes('建立卡片'));
  });

  test('正在看的那張卡在側欄裡被標起來', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '這一張', body: 'x' });
    const body = (await h.app.fastify.inject(`/c/${id}`)).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
    assert.ok(aside.includes(`href="/c/${id}" class="on"`));
  });
});

describe('欄位變更', () => {
  test('新寫出去的卡片檔不再有 archive_url', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '一', body: 'x' });
    const raw = fs.readFileSync(path.join(h.corpus, 'cards', `${id}.md`), 'utf8');
    assert.ok(!raw.includes('archive_url'));
    assert.ok(raw.includes('url: null'));
  });

  test('認不得的欄位被忽略，認不得的值則整張卡解析失敗', async () => {
    const h = await fresh();
    const write = (id: string, extra: string[]) =>
      fs.writeFileSync(
        path.join(h.corpus, 'cards', `${id}.md`),
        ['---', `id: "${id}"`, 'type: original', 'created: "2026-09-03T00:00:00.000Z"',
         `title: ${id}`, 'tags: []', 'url: null', ...extra, 'revised: null', 'links: []',
         '---', '', 'body', ''].join('\n'),
        'utf8',
      );

    // 多出來的欄位只是被跳過。
    write('88700000000000001', ['archive_url: "https://web.archive.org/x"', 'provenance: default']);
    // 認不得的值不能默默吞掉，要算成解析失敗並列進報告。
    write('88700000000000002', ['provenance: published-translation']);

    const report = (await h.app.fastify.inject({ method: 'POST', url: '/_reindex' })).json() as {
      indexed: number;
      failures: { file: string }[];
    };
    assert.equal(report.indexed, 1);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0]!.file, /88700000000000002/);
  });

  test('建立時只接受新的 provenance', async () => {
    const h = await fresh();
    const bad = await postCard(h, {
      type: 'original',
      title: 'x',
      provenance: 'machine',
    });
    assert.equal(bad.statusCode, 400);
    assert.match((bad.json() as { errors: string[] }).errors.join(), /provenance/);

    for (const p of ['default', 'translated', 'AI-summarized']) {
      const id = await createCard(h, { type: 'original', title: `p-${p}`, body: 'x', provenance: p });
      const raw = fs.readFileSync(path.join(h.corpus, 'cards', `${id}.md`), 'utf8');
      assert.ok(raw.includes(`provenance: ${p}`), p);
    }
  });
});

describe('provenance 欄位', () => {
  test('沒選 original 時表單上的 provenance 是關著的，不會被送出', async () => {
    const h = await fresh();
    const blank = (await h.app.fastify.inject('/new')).body;
    assert.match(blank, /id="provfield"/);
    assert.match(blank, /<select name="provenance" disabled>/, '沒選類型時應該是關著的');

    const asOriginal = (await h.app.fastify.inject('/new?type=original')).body;
    assert.match(asOriginal, /<select name="provenance" >/, 'original 時應該可以選');

    const asThink = (await h.app.fastify.inject('/new?type=thinking')).body;
    assert.match(asThink, /<select name="provenance" disabled>/);
  });

  test('非 original 夾帶 provenance 不會被擋，只是不寫進卡片', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'thinking',
        title: '沒有 provenance 的思考卡',
        body: 'x',
        provenance: 'translated',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 302, '不該退回 400');

    const id = (res.headers.location as string).replace('/c/', '');
    const raw = fs.readFileSync(path.join(h.corpus, 'cards', `${id}.md`), 'utf8');
    assert.ok(raw.includes('provenance: null'), '非 original 的卡片不該有 provenance');
  });
});

describe('引用錨點', () => {
  test('每個頂層區塊都掛上 b0、b1、b2……', () => {
    const html = renderMarkdown('# 標題\n\n第一段。\n\n- a\n- b\n\n> 引言\n\n最後一段。');
    for (const n of [0, 1, 2, 3, 4]) {
      assert.ok(html.includes(`id="b${n}"`), `缺少 b${n}`);
      assert.ok(html.includes(`data-b="${n}"`), `缺少 data-b=${n}`);
    }
    assert.ok(!html.includes('id="b5"'), '不該多出區塊');
    // 段落裡的行內內容不算一個區塊。
    assert.equal((html.match(/data-b=/g) ?? []).length, 5);
  });

  test('同一份內文渲染兩次，序號完全一樣', () => {
    const src = '一\n\n二\n\n三';
    assert.equal(renderMarkdown(src), renderMarkdown(src));
  });

  test('引用連結指到卡片頁時，那個區塊找得到', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '有好幾段的原文',
      body: '第一段。\n\n第二段，會被引用。\n\n第三段。',
    });
    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.ok(page.includes('id="b1"'), '卡片頁要有可以跳過去的錨點');
    assert.ok(page.includes('第二段，會被引用。'));
  });
});

describe('建立頁的來源面板', () => {
  test('帶著 to 就分欄，並且整篇原文都在左邊', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '被參照的原文',
      body: '第一段。\n\n第二段。',
      tags: ['甲'],
    });

    const split = (await h.app.fastify.inject(`/new?type=thinking&to=${id}`)).body;
    assert.ok(split.includes('class="split"'), '應該分欄');
    assert.ok(split.includes('id="sourcepane"'));
    assert.ok(split.includes('id="splitbar"'), '應該有可拖曳的分隔線');
    assert.ok(split.includes('第二段。'), '整篇原文都要在，不是只有標題');
    assert.ok(split.includes('data-b="1"'), '來源面板要帶著區塊序號');
    assert.ok(split.includes('id="quotebtn"'));

    const plain = (await h.app.fastify.inject('/new')).body;
    assert.ok(!plain.includes('class="split"'), '沒有來源就不分欄');
    assert.ok(!plain.includes('id="sourcepane"'));
  });

  test('驗證失敗退回時，來源面板跟著回來', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '被參照的原文', body: 'x' });
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'thinking',
        title: '',
        body: '寫了一半',
        reply_to: id,
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.includes('id="sourcepane"'), '來源面板不該消失');
    assert.ok(res.body.includes('被參照的原文'));
    assert.ok(res.body.includes('寫了一半'), '打好的字也不該消失');
  });
});

describe('卡片頁的方向', () => {
  test('上游在內文之上、下游在內文之下，都不帶標題文字', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });
    await createCard(h, {
      type: 'thinking',
      title: 'C 引用 B',
      body: 'z',
      links: [{ rel: 'supports', to: b }],
    });

    const page = (await h.app.fastify.inject(`/c/${b}`)).body;
    const up = page.indexOf('class="stream up"');
    const card = page.indexOf('<article');
    const down = page.indexOf('class="stream down"');

    assert.ok(up > -1 && card > -1 && down > -1, '三塊都要在');
    assert.ok(up < card, '上游要在內文之上');
    assert.ok(card < down, '下游要在內文之下');
    assert.ok(page.includes('↑ 1') && page.includes('↓ 1'), '方向用箭頭加數量表示');
    assert.ok(!page.includes('cited by') && !page.includes('linkslabel'), '不再有文字標題');
  });

  test('沒有上游或下游時，那一塊整個不出現', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '孤零零', body: 'x' });
    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.ok(!page.includes('class="stream'), '空的方向不該留下空殼');
    assert.ok(!page.includes('↑') && !page.includes('↓'));
  });

  test('provenance 是 default 就不顯示', async () => {
    const h = await fresh();
    const plain = await createCard(h, { type: 'original', title: '沒特別來歷', body: 'x' });
    const page = (await h.app.fastify.inject(`/c/${plain}`)).body;
    assert.ok(page.includes('original'), 'type 還是要顯示');
    assert.ok(!page.includes('default'), 'default 不該佔版面');

    const tl = await createCard(h, {
      type: 'original',
      title: '翻譯來的',
      body: 'x',
      provenance: 'translated',
    });
    assert.ok((await h.app.fastify.inject(`/c/${tl}`)).body.includes('translated'));
  });
});

describe('連結列與引用串的操作', () => {
  test('每一列連結都有移除鈕，而且不是警示色', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '目標', body: 'x' });
    const page = (await h.app.fastify.inject(`/new?type=thinking&to=${id}`)).body;

    assert.ok(page.includes('class="ghost rmlink"'), '預填的那一列要有移除鈕');
    assert.ok(page.includes('id="addlink"'));
    // 移除鈕跟新增鈕用同一個 ghost 樣式，沒有自己的警示色。
    assert.ok(!page.includes('rmlink danger') && !page.includes('rmlink warn'));

    const tplStart = page.indexOf('<template id="linkrowtpl">');
    assert.ok(page.slice(tplStart).includes('rmlink'), '動態新增的列也要有');
  });

  test('引用串的每一則整塊都可以點', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    await createCard(h, {
      type: 'thinking',
      title: 'B 引用 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    assert.ok(page.includes('class="nodehead"'), '可點區域要包住標題與日期');
    const head = page.slice(page.indexOf('class="nodehead"'));
    assert.ok(head.indexOf('nodemeta') < head.indexOf('</div>'), '日期與類型要在可點區域裡面');
  });
});

describe('中文全文檢索', () => {
  test('中日文逐字切開，其他語言維持整詞', () => {
    assert.equal(segmentCjk('近可分解').trim().replace(/ +/g, ' '), '近 可 分 解');
    assert.equal(segmentCjk('simon 寫的').includes('simon'), true);
    assert.equal(segmentCjk('abc'), 'abc');
  });

  test('中文查詢變成 phrase，等價於子字串比對', () => {
    assert.equal(ftsQuery('分解'), '"分 解"');
    assert.equal(ftsQuery('simon'), '"simon"*');
    assert.equal(ftsQuery('simon 分解'), '"simon"* "分 解"');
    assert.equal(ftsQuery('   '), null);
  });

  test('詞出現在句子中間也找得到', async () => {
    const h = await fresh();
    await createCard(h, {
      type: 'original',
      title: '賽門論近可分解系統',
      body: '子系統內部的互動遠強於子系統之間的互動。',
    });
    await createCard(h, { type: 'thinking', title: '無關的一張', body: '天氣很好' });

    // 這些詞全都不在 token 開頭，改逐字切分之前一個都找不到。
    for (const q of ['分解', '可分解系統', '互動', '近可分解', '系統內部']) {
      assert.equal(h.app.index.search(q, 50).length, 1, `搜「${q}」應該找得到`);
    }
    assert.equal(h.app.index.search('天氣', 50).length, 1, '不該把不相干的也撈進來');
    assert.equal(h.app.index.search('不存在的詞', 50).length, 0);
  });
});

describe('prepared statement 快取', () => {
  test('同一句 SQL 不會重複 prepare', async () => {
    const h = await fresh();
    const db = h.app.index.handle;
    let prepared = 0;
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      prepared += 1;
      return real(sql);
    };

    for (let i = 0; i < 30; i += 1) h.app.index.countCards();
    assert.equal(prepared, 1, '三十次查詢只該準備一次');
  });

  test('重建索引之後，舊的 statement 不會被拿來用', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '重建前', body: 'x' });
    assert.equal(h.app.index.countCards(), 1);

    // rebuild 會 close 舊的資料庫再開新的。快取沒清的話，
    // 下一次查詢會拿著已關閉資料庫的 statement，直接炸掉。
    h.app.index.rebuild();

    assert.equal(h.app.index.countCards(), 1);
    assert.equal(h.app.index.getCard(id)?.title, '重建前');
    assert.equal((await h.app.fastify.inject(`/c/${id}`)).statusCode, 200);
  });
});

describe('索引的耐久性設定', () => {
  test('索引用 WAL，而且不為了可拋棄的快取付最高耐久成本', async () => {
    const h = await fresh();
    const db = h.app.index.handle;
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    // 1 = NORMAL。索引壞了就重建，不需要 FULL(2) 那種每次交易多好幾個 fsync 的成本。
    assert.equal(db.pragma('synchronous', { simple: true }), 1);
  });

  test('只砍掉主檔、留下孤兒 WAL，重開仍然重建得回來', async () => {
    const ws = makeWorkspace();
    const first = await start(ws);
    const id = await createCard(first, { type: 'original', title: '要被重建的卡', body: '內文。' });
    const before = (await first.app.fastify.inject(`/c/${id}`)).body;
    await first.close();

    // 演練時很容易只下 rm index.db，把 -wal 留在原地。
    fs.writeFileSync(`${ws.indexPath}-wal`, 'garbage');
    fs.rmSync(ws.indexPath, { force: true });

    const second = await start(ws);
    cleanups.push(second.close);
    assert.equal(second.app.index.countCards(), 1);
    assert.equal((await second.app.fastify.inject(`/c/${id}`)).body, before);
  });
});

describe('分欄的斷點', () => {
  const css = fs.readFileSync('public/style.css', 'utf8');
  const js = fs.readFileSync('public/new.js', 'utf8');

  test('CSS 與 JS 講的是同一條線', () => {
    // 版面由 CSS 切換、拖曳比例由 JS 記錄，兩邊對不上就會存錯方向的比例。
    const fromCss = css.match(/@media \(min-width: ([\d.]+)rem\) \{\s*\.split \{/);
    const fromJs = js.match(/matchMedia\('\(min-width: ([\d.]+)rem\)'\)/);
    assert.ok(fromCss, 'style.css 找不到分欄的 media query');
    assert.ok(fromJs, 'new.js 找不到對應的 matchMedia');
    assert.equal(fromCss[1], fromJs[1]);
  });

  test('斷點低到 11 吋 iPad 直放也算左右分', () => {
    const rem = Number(css.match(/@media \(min-width: ([\d.]+)rem\) \{\s*\.split \{/)![1]);
    // iPad Air 11" 直放 820px 是這一類裡最窄的，橫放 1180px 最寬。
    assert.ok(rem * 16 <= 820, `斷點 ${rem}rem 太高，iPad 直放會退回上下分`);
  });

  test('拖曳出來的比例，直放與橫放分開記', () => {
    assert.match(js, /append-cards:split:/);
    assert.match(js, /wide\.matches \? 'col' : 'row'/);
  });
});
