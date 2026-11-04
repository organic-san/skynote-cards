import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { excerpt } from '../src/web/present.ts';
import { createCard, makeWorkspace, start, type Harness } from './helpers.ts';

/** v3.2 規格（spec/Append_cards_v3.2_spec.md）：時間軸的內文開頭拉長、已被取代的卡不列。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(): Promise<Harness> {
  const h = await start(makeWorkspace());
  cleanups.push(h.close);
  return h;
}

const enc = encodeURIComponent;

function main(body: string): string {
  return body.slice(body.indexOf('<main>'), body.indexOf('</main>'));
}

function aside(body: string): string {
  return body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
}

/** 結果清單本身（篩選列之後）。 */
function rows(body: string): string {
  const m = main(body);
  const at = m.indexOf('<ul class="rows">');
  return at === -1 ? '' : m.slice(at);
}

function filters(body: string): string {
  const m = main(body);
  return m.slice(m.indexOf('<div class="filters">'), m.indexOf('</div>', m.indexOf('<div class="filters">')));
}

/** 卡片頁頂端的提示；沒有就是空字串。 */
function notice(body: string): string {
  const at = body.indexOf('<div class="superseded">');
  return at === -1 ? '' : body.slice(at, body.indexOf('</div>', at));
}

const get = async (h: Harness, url: string) => (await h.app.fastify.inject(url)).body;

const css = (name: string) => fs.readFileSync(path.join('public', 'css', `${name}.css`), 'utf8');

describe('§1 時間軸的內文開頭', () => {
  test('保留換行、去掉空行；取前 5 行，多的以 … 收尾', () => {
    const body = '第一行\n\n第二行\n   \n第三行\n第四行\n第五行\n第六行';
    assert.equal(excerpt(body), '第一行\n第二行\n第三行\n第四行\n第五行…');
    assert.equal(excerpt('一行\n\n兩行'), '一行\n兩行', '沒有超過就不加 …');
  });

  test('字數上限 300（以字算，換行也算一個）', () => {
    const long = '字'.repeat(400);
    const out = excerpt(long);
    assert.equal([...out].length, 301);
    assert.ok(out.endsWith('…'));
    assert.equal(excerpt('字'.repeat(300)), '字'.repeat(300));
  });

  test('條列換成「・」，標題、引言、強調、連結的記號拿掉；程式碼區塊、分隔線、表格的對齊列整段不要', () => {
    const md = [
      '## 小標',
      '- 第一項',
      '* [x] 做完的事',
      '> 引一句 **重點**',
      '```js',
      'const x = 1;',
      '```',
      '---',
      '| a | b |',
      '|---|:-:|',
      '[連結文字](https://example.com)',
    ].join('\n');
    assert.equal(excerpt(md), '小標\n・第一項\n・做完的事\n引一句 重點\n| a | b |…');
    assert.equal(excerpt('#標籤 開頭的一行'), '#標籤 開頭的一行', '沒有空格的 # 不是標題');
  });

  test('時間軸上換行排得出來；搜尋的命中片段照舊兩行', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '多行的卡', body: '甲行\n\n乙行\n丙行' });
    await createCard(h, { type: 'fleeting', title: '碎片一\n碎片二' });

    const feed = rows(await get(h, '/'));
    assert.ok(feed.includes('<p class="rowtext rowlines">甲行\n乙行\n丙行</p>'));
    assert.match(feed, /<a class="rowtext rowbody rowlines" href="\/c\/\d+">碎片一\n碎片二<\/a>/);

    const search = rows(await get(h, `/search?q=${enc('乙行')}`));
    assert.match(search, /<p class="rowtext">/);
    assert.ok(!search.includes('rowlines'), '搜尋結果用命中片段，不套多行');

    const list = css('list');
    assert.match(list, /\.rowlines\s*\{[^}]*white-space:\s*pre-line/);
    assert.match(list, /\.rowlines\s*\{[^}]*-webkit-line-clamp:\s*8/);
    assert.match(list, /\.rowtext\s*\{[^}]*-webkit-line-clamp:\s*2/, '命中片段維持兩行');
  });
});

describe('§2 已被更新或反駁的卡', () => {
  test('首頁不列；篩選列「全部」名字不變，碎片右邊多一個「× 已隱藏」', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張' });
    await createCard(h, { type: 'thinking', title: '新的主張', links: [{ rel: 'updates', to: old }] });

    const page = await get(h, '/');
    assert.ok(rows(page).includes('新的主張'));
    assert.ok(!rows(page).includes('舊的主張'));
    assert.match(page, /<span class="filtercount">1<\/span>/, '總數不含已隱藏的');

    const bar = filters(page);
    assert.match(bar, /class="textbtn on">全部<\/a>/);
    const fleetingAt = bar.indexOf('?type=fleeting');
    const hiddenAt = bar.indexOf('href="/?hidden=1"');
    assert.ok(fleetingAt > -1 && hiddenAt > fleetingAt, '「已隱藏」排在碎片右邊');
    assert.match(bar, /<svg class="icon icon-x"[^>]*>[\s\S]*?<\/svg>\s*已隱藏<\/a>/, '前面是一個 ×');
    assert.ok(!bar.includes('class="num"'), '不顯示數量');
  });

  test('「已隱藏」那一頁只列被取代的卡；型別篩選照樣不列', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張' });
    await createCard(h, { type: 'thinking', title: '新的主張', links: [{ rel: 'updates', to: old }] });

    const hidden = await get(h, '/?hidden=1');
    assert.ok(rows(hidden).includes('舊的主張'));
    assert.ok(!rows(hidden).includes('新的主張'));
    assert.match(filters(hidden), /class="textbtn hiddentab on"/);
    assert.ok(!/class="textbtn on">全部/.test(filters(hidden)));

    // 跟型別互斥：兩個都帶時只認「已隱藏」。
    const both = await get(h, '/?hidden=1&type=thinking');
    assert.ok(rows(both).includes('舊的主張'));
    assert.doesNotMatch(filters(both), /class="textbtn on">\s*<span class="dot/);

    const typedPage = await get(h, '/?type=thinking');
    assert.match(filters(typedPage), /class="textbtn on">\s*<span class="dot dot-thinking/, '這個比對抓得到選中的型別');
    const typed = rows(typedPage);
    assert.ok(typed.includes('新的主張') && !typed.includes('舊的主張'));
  });

  test('沒有被取代的卡就沒有「已隱藏」', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '一張卡' });
    assert.ok(!filters(await get(h, '/')).includes('已隱藏'));
  });

  test('反駁也算；牴觸不算（還沒裁決）', async () => {
    const h = await fresh();
    const refuted = await createCard(h, { type: 'thinking', title: '被推翻的' });
    const contested = await createCard(h, { type: 'thinking', title: '被牴觸的' });
    await createCard(h, { type: 'thinking', title: '反駁它', links: [{ rel: 'refutes', to: refuted }] });
    await createCard(h, { type: 'thinking', title: '牴觸它', links: [{ rel: 'contradicts', to: contested }] });

    const feed = rows(await get(h, '/'));
    assert.ok(!feed.includes('被推翻的'));
    assert.ok(feed.includes('被牴觸的'));
    const hidden = rows(await get(h, '/?hidden=1'));
    assert.ok(hidden.includes('被推翻的') && !hidden.includes('被牴觸的'));
  });

  test('完整化過的碎片也不列', async () => {
    const h = await fresh();
    const fleeting = await createCard(h, { type: 'fleeting', title: '隨口的一句' });
    await createCard(h, {
      type: 'thinking',
      title: '完整的主張',
      links: [{ rel: 'updates', to: fleeting }],
    });
    assert.ok(!rows(await get(h, '/')).includes('隨口的一句'));
    assert.ok(rows(await get(h, '/?hidden=1')).includes('隨口的一句'));
  });

  test('標籤的時間軸一樣不列；「已隱藏」帶著標籤，這個標籤沒有被取代的卡就不出現', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '沒被取代過', tags: ['生物'] });
    const old = await createCard(h, { type: 'thinking', title: '舊的主張', tags: ['物理'] });
    await createCard(h, {
      type: 'thinking',
      title: '新的主張',
      tags: ['物理'],
      links: [{ rel: 'updates', to: old }],
    });
    const other = await createCard(h, { type: 'thinking', title: '別的話題', tags: ['化學'] });
    await createCard(h, {
      type: 'thinking',
      title: '別的話題的新版',
      tags: ['化學'],
      links: [{ rel: 'updates', to: other }],
    });

    const tagged = await get(h, `/?tag=${enc('物理')}`);
    assert.ok(rows(tagged).includes('新的主張'));
    assert.ok(!rows(tagged).includes('舊的主張'));
    assert.ok(filters(tagged).includes(`href="/?hidden=1&amp;tag=${enc('物理')}"`));
    assert.ok(
      !filters(await get(h, `/?tag=${enc('生物')}`)).includes('已隱藏'),
      '別的標籤被取代的卡不算進來',
    );

    const hiddenTagged = rows(await get(h, `/?hidden=1&tag=${enc('物理')}`));
    assert.ok(hiddenTagged.includes('舊的主張'));
    assert.ok(!hiddenTagged.includes('別的話題'));
  });

  test('標籤頁的計數照算被取代的卡：它記的是在這個話題上打轉了幾次', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張', tags: ['物理'] });
    await createCard(h, {
      type: 'thinking',
      title: '新的主張',
      tags: ['物理'],
      links: [{ rel: 'updates', to: old }],
    });
    const tags = main(await get(h, '/tags'));
    const at = tags.indexOf('#物理');
    assert.ok(at > -1);
    assert.match(tags.slice(at, at + 200), /<span class="n">2<\/span>/);
  });

  test('側欄的最近卡片不列；搜尋照樣找得到', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張' });
    const fresh2 = await createCard(h, {
      type: 'thinking',
      title: '新的主張',
      links: [{ rel: 'updates', to: old }],
    });
    const side = aside(await get(h, `/c/${fresh2}`));
    assert.ok(side.includes('新的主張'));
    assert.ok(!side.includes('舊的主張'));

    assert.ok(rows(await get(h, `/search?q=${enc('舊的主張')}`)).includes('舊的主張'));
  });

  test('卡片頁頂端：淺紅底的一行，說被誰更新、被誰反駁，連過去', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張' });
    const a = await createCard(h, { type: 'thinking', title: '新版甲', links: [{ rel: 'updates', to: old }] });
    const b = await createCard(h, { type: 'thinking', title: '新版乙', links: [{ rel: 'updates', to: old }] });
    const r = await createCard(h, { type: 'thinking', title: '反駁它', links: [{ rel: 'refutes', to: old }] });

    const page = await get(h, `/c/${old}`);
    const box = notice(page);
    assert.ok(box, '有提示');
    assert.ok(page.indexOf('<div class="superseded">') < page.indexOf('<h1'), '排在標題之上');
    assert.ok(box.indexOf('本文已被更新') < box.indexOf('本文已被反駁'), '更新在前');
    assert.match(box, /<strong>本文已被更新<\/strong>：<a href="\/c\/\d+">/, '「本文已被更新：新卡」');
    for (const id of [a, b, r]) assert.ok(box.includes(`href="/c/${id}"`));
    assert.ok(box.includes('新版甲') && box.includes('新版乙') && box.includes('反駁它'));

    assert.equal(notice(await get(h, `/c/${a}`)), '', '新的那張沒有提示');

    assert.match(css('card'), /\.superseded\s*\{[^}]*background:\s*var\(--superseded-bg\)/);
    assert.match(css('tokens'), /--superseded-bg:\s*#[0-9A-Fa-f]{6}/);
  });

  test('碎片被完整化時說「已完整化」；只連直接指過來的那張，不追到鏈尾', async () => {
    const h = await fresh();
    const fleeting = await createCard(h, { type: 'fleeting', title: '隨口的一句' });
    const first = await createCard(h, {
      type: 'thinking',
      title: '第一版',
      links: [{ rel: 'updates', to: fleeting }],
    });
    const second = await createCard(h, {
      type: 'thinking',
      title: '第二版',
      links: [{ rel: 'updates', to: first }],
    });

    const box = notice(await get(h, `/c/${fleeting}`));
    assert.match(box, /<strong>已完整化<\/strong>/);
    assert.ok(box.includes(`href="/c/${first}"`));
    assert.ok(!box.includes(`href="/c/${second}"`));

    const mid = notice(await get(h, `/c/${first}`));
    assert.match(mid, /<strong>本文已被更新<\/strong>/);
    assert.ok(mid.includes(`href="/c/${second}"`));
  });

  test('取代它的卡在別的環境：照樣不列，提示標出那個環境', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/envs',
      payload: `name=${enc('繪圖')}&from=`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 302);
    const old = await createCard(h, { type: 'thinking', title: '舊的主張' });
    const moved = await h.app.fastify.inject({
      method: 'POST',
      url: `/e/${enc('繪圖')}/new`,
      payload: { type: 'thinking', title: '別處的新版', tags: ['測試'], links: [{ rel: 'updates', to: old }] },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(moved.statusCode, 302, moved.body);

    assert.ok(!rows(await get(h, '/')).includes('舊的主張'));
    assert.match(notice(await get(h, `/c/${old}`)), /<span class="envmark">繪圖<\/span>/);
  });
});
