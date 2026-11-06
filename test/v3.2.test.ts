import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import vm from 'node:vm';
import { carryLinks, excerpt } from '../src/web/present.ts';
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

describe('§4 Markdown 工具列與清單延續', () => {
  interface Edit {
    from: number;
    to: number;
    text: string;
    selStart: number;
    selEnd: number;
  }
  interface Md {
    edit(name: string, value: string, s: number, e: number): Edit | null;
    enter(value: string, s: number, e: number): Edit | null;
  }

  // 文字運算不碰 DOM，所以直接在 vm 裡跑那支檔案：沒有 document，它就只掛上 window.skynoteMd。
  const sandbox: { window: { skynoteMd?: Md } } = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join('public', 'js', 'mdbar.js'), 'utf8'), sandbox);
  const md = sandbox.window.skynoteMd as Md;

  // 游標寫成 |，選取寫成 «…»。
  function read(input: string): { value: string; s: number; e: number } {
    const caret = input.indexOf('|');
    if (caret !== -1) return { value: input.replace('|', ''), s: caret, e: caret };
    const s = input.indexOf('«');
    const e = input.indexOf('»') - 1;
    return { value: input.replace('«', '').replace('»', ''), s, e };
  }
  function show(ed: Edit | null, value: string): string | null {
    if (!ed) return null;
    const out = value.slice(0, ed.from) + ed.text + value.slice(ed.to);
    return ed.selStart === ed.selEnd
      ? out.slice(0, ed.selStart) + '|' + out.slice(ed.selStart)
      : out.slice(0, ed.selStart) + '«' + out.slice(ed.selStart, ed.selEnd) + '»' + out.slice(ed.selEnd);
  }
  const press = (name: string, input: string) => {
    const r = read(input);
    return show(md.edit(name, r.value, r.s, r.e), r.value);
  };
  const enter = (input: string) => {
    const r = read(input);
    return show(md.enter(r.value, r.s, r.e), r.value);
  };

  test('待辦、已完成：補上清單記號與方框；已經是這個狀態就拿掉', () => {
    assert.equal(press('task', '|'), '- [ ] |');
    assert.equal(press('task', '買|票'), '- [ ] 買|票');
    assert.equal(press('task', '- 買票|'), '- [ ] 買票|');
    assert.equal(press('task', '  * 子項|'), '  * [ ] 子項|', '縮排與記號原樣留著');
    assert.equal(press('task', '1. 買票|'), '1. [ ] 買票|', '編號清單保留編號');
    assert.equal(press('task', '- [x] 買票|'), '- [ ] 買票|');
    assert.equal(press('done', '- [ ] 買票|'), '- [x] 買票|');
    assert.equal(press('done', '- [X] 買票|'), '買票|', '[X] 與 [x] 同義');
    assert.equal(press('task', '- [ ] 買票|'), '買票|');
    assert.equal(press('task', '> 引言裡|'), '> - [ ] 引言裡|');
  });

  test('選了好幾行：每一行都套上，中間的空行不動；選取跟著內容走', () => {
    assert.equal(press('task', '«甲\n\n乙»'), '- [ ] «甲\n\n- [ ] 乙»');
    assert.equal(press('task', '«- [ ] 甲\n- [ ] 乙»'), '«甲\n乙»', '全部都是待辦才拿掉');
    assert.equal(press('task', '«- [ ] 甲\n乙»'), '- [ ] «甲\n- [ ] 乙»', '有一行不是就全部補上');
    assert.equal(press('task', '«甲\n»乙'), '- [ ] «甲\n»乙', '選取停在下一行的開頭，那一行不算');
  });

  test('清單、編號：換清單記號，方框留著；編號接著上一行往下排', () => {
    assert.equal(press('bullet', '甲|'), '- 甲|');
    assert.equal(press('bullet', '- 甲|'), '甲|');
    assert.equal(press('bullet', '1. [x] 甲|'), '- [x] 甲|');
    assert.equal(press('ordered', '«甲\n乙\n丙»'), '1. «甲\n2. 乙\n3. 丙»');
    assert.equal(press('ordered', '1. 甲\n|'), '1. 甲\n2. |');
    assert.equal(press('ordered', '- [ ] 甲|'), '1. [ ] 甲|');
    assert.equal(press('ordered', '1. 甲|'), '甲|');
  });

  test('引用：每一行前面加 >，中間的空行補 > 不讓引言斷開；都在引言裡就拿掉一層', () => {
    assert.equal(press('quote', '甲|'), '> 甲|');
    assert.equal(press('quote', '«甲\n\n乙»'), '> «甲\n>\n> 乙»');
    assert.equal(press('quote', '> 甲|'), '甲|');
    assert.equal(press('quote', '> > 甲|'), '> 甲|');
  });

  test('粗體、斜體、程式碼：包住選取；已經包著就拿掉', () => {
    assert.equal(press('bold', '«重點»'), '**«重點»**');
    assert.equal(press('bold', '**«重點»**'), '«重點»');
    assert.equal(press('bold', '«**重點**»'), '«重點»', '記號被選進去也認得');
    assert.equal(press('italic', '«重點»'), '*«重點»*');
    assert.equal(press('italic', '**«重點»**'), '***«重點»***', '粗體的兩顆星不是斜體');
    assert.equal(press('italic', '***«重點»***'), '**«重點»**');
    assert.equal(press('bold', '***«重點»***'), '*«重點»*');
    assert.equal(press('code', '«x = 1»'), '`«x = 1»`');
    assert.equal(press('code', '`«x = 1»`'), '«x = 1»');
    assert.equal(press('bold', '«重點 »後面'), '**«重點»** 後面', '選進去的空白留在記號外面');
  });

  test('沒有選取：插入一對記號，游標在中間；馬上再按一次就收回去', () => {
    assert.equal(press('bold', '甲|'), '甲**|**');
    assert.equal(press('bold', '甲**|**'), '甲|');
    assert.equal(press('italic', '|'), '*|*');
    assert.equal(press('italic', '*|*'), '|');
  });

  test('程式碼選了好幾行：改成程式碼區塊', () => {
    assert.equal(press('code', '«a\nb»'), '```\n«a\nb»\n```');
  });

  test('連結：選的是字，游標停在括號裡等網址；選的是網址，游標停在方括號裡等字', () => {
    assert.equal(press('link', '|'), '[|]()');
    assert.equal(press('link', '«說明»'), '[說明](|)');
    assert.equal(press('link', '«https://example.com/a»'), '[|](https://example.com/a)');
    assert.equal(press('link', '«/c/123#b2»'), '[|](/c/123#b2)', '站內的卡片網址也算');
  });

  test('Enter：清單項目延續同樣的記號；待辦的下一項一律從未完成開始', () => {
    assert.equal(enter('- [ ] 甲|'), '- [ ] 甲\n- [ ] |');
    assert.equal(enter('- [x] 甲|'), '- [x] 甲\n- [ ] |');
    assert.equal(enter('- 甲|'), '- 甲\n- |');
    assert.equal(enter('  * 甲|'), '  * 甲\n  * |', '縮排與記號照抄');
    assert.equal(enter('1. 甲|'), '1. 甲\n2. |');
    assert.equal(enter('9) 甲|'), '9) 甲\n10) |');
    assert.equal(enter('1. [ ] 甲|'), '1. [ ] 甲\n2. [ ] |');
    assert.equal(enter('> - 甲|'), '> - 甲\n> - |', '引言裡的清單');
    assert.equal(enter('- 甲|乙'), '- 甲\n- |乙', '游標在字中間：後半段成為下一項');
  });

  test('Enter：空的一項結束清單', () => {
    assert.equal(enter('- [ ] 甲\n- [ ] |'), '- [ ] 甲\n|');
    assert.equal(enter('- |'), '|');
    assert.equal(enter('  - |'), '|', '只是縮排的話一起拿掉');
    assert.equal(enter('> - |'), '> |', '還在引言裡，> 留著');
  });

  test('Enter：不在清單項目上、游標在記號前面、在程式碼區塊裡、有選取，都照常換行', () => {
    assert.equal(enter('甲|'), null);
    assert.equal(enter('> 甲|'), null, '引言本身不延續');
    assert.equal(enter('|- 甲'), null);
    assert.equal(enter('- [ |] 甲'), null);
    assert.equal(enter('```\n- 甲|'), null);
    assert.equal(enter('```\n```\n- 甲|'), '```\n```\n- 甲\n- |', '區塊關上之後就是清單');
    assert.equal(enter('-甲|'), null, '記號後面沒有空格不是清單');
    assert.equal(enter('10/7|'), null, '日期不是編號');
    assert.equal(enter('- «甲»'), null);
  });

  const MD_KEYS = ['task', 'done', 'bullet', 'ordered', 'quote', 'bold', 'italic', 'code', 'link'];
  const keys = (html: string, id: string) => {
    const at = html.indexOf(`aria-controls="${id}"`);
    const bar = html.slice(at, html.indexOf('</div>', at));
    return [...bar.matchAll(/data-md="([a-z]+)"/g)].map((m) => m[1]);
  };

  test('建立表單：內文與碎片的文字框上方各一列；工具列在 <label> 外面', async () => {
    const h = await fresh();
    const html = await get(h, '/new');
    assert.match(
      html,
      /<label for="bodytext">內文<\/label>\s*<div class="mdbar" role="toolbar" aria-label="Markdown" aria-controls="bodytext">/,
    );
    assert.match(html, /<\/div>\s*<textarea name="body" id="bodytext"[^>]*data-mdbar/);
    assert.match(html, /<div class="field off" id="singlefield">\s*<div class="mdbar"[^>]*aria-controls="singletext">/);
    assert.match(html, /<textarea name="quick_body" id="singletext"[^>]*data-mdbar/);
    assert.deepEqual(keys(html, 'bodytext'), MD_KEYS);
    assert.deepEqual(keys(html, 'singletext'), MD_KEYS);
    assert.ok(html.includes('/static/js/mdbar.js'));
  });

  test('編輯表單：思考的內文、碎片的那段話都有', async () => {
    const h = await fresh();
    const thinking = await createCard(h, { type: 'thinking', title: '想法', body: '- [ ] 甲' });
    const fleeting = await createCard(h, { type: 'fleeting', title: '一句話' });

    const edit = await get(h, `/c/${thinking}/edit`);
    assert.match(edit, /<label for="bodytext">內文<\/label>\s*<div class="mdbar"/);
    assert.match(edit, /<textarea name="body" id="bodytext"[^>]*data-mdbar>- \[ \] 甲\n?<\/textarea>/);
    assert.ok(edit.includes('/static/js/mdbar.js'));

    const single = await get(h, `/c/${fleeting}/edit`);
    assert.match(single, /<textarea name="quick_body" id="singletext"[^>]*data-mdbar>一句話<\/textarea>/);
    assert.deepEqual(keys(single, 'singletext'), MD_KEYS);
  });

  test('隨手記不放：它要的是快', async () => {
    const h = await fresh();
    const home = await get(h, '/');
    assert.ok(home.includes('id="quickform"'));
    assert.ok(!home.includes('data-mdbar'));
    assert.ok(!home.includes('class="mdbar"'));
    assert.ok(!home.includes('mdbar.js'));
  });

  test('沒有 JS 不顯示工具列', () => {
    assert.match(css('form'), /html:not\(\.js\) \.mdbar \{ display: none; \}/);
  });
});

describe('§5 帶入原卡的連結', () => {
  const link = (rel: string, id: string, type: string | null, title: string | null = `卡${id}`) => ({
    rel,
    id,
    env: '',
    title,
    type,
    created: null,
    body: null,
  });

  test('關係沿用原卡的那一條', () => {
    assert.deepEqual(carryLinks('thinking', [link('related', '1', 'thinking'), link('supports', '2', 'restatement')]), [
      { rel: 'related', to: '1', title: '卡1', targetType: 'thinking' },
      { rel: 'supports', to: '2', title: '卡2', targetType: 'restatement' },
    ]);
  });

  test('不帶：原卡的更新與反駁、找不到的目標、新卡的型別連不到的目標', () => {
    assert.deepEqual(
      carryLinks('thinking', [
        link('updates', '1', 'thinking'),
        link('refutes', '2', 'fleeting'),
        link('related', '3', null, null),
      ]),
      [],
    );
    assert.deepEqual(carryLinks('restatement', [link('related', '4', 'thinking')]), [], '重述連不到思考');
    assert.deepEqual(carryLinks('fleeting', [link('related', '5', 'thinking')]), [], '碎片不能有連結（R2）');
  });

  test('新卡的型別不允許那條關係時，退到 DEFAULT_REL；取代類的關係不在退路裡', () => {
    // 產出不能 supports：退到 related。
    assert.equal(carryLinks('output', [link('supports', '1', 'restatement')])[0]?.rel, 'related');
    // 思考指向資料時 about 排在矩陣的第一個，但退路是弱的那一端。
    assert.equal(carryLinks('thinking', [link('part-of', '2', 'original')])[0]?.rel, 'related');
    // 重述指向重述只剩 updates 合法：不帶，而不是暗地裡讓它從時間軸消失。
    assert.deepEqual(carryLinks('restatement', [link('about', '3', 'restatement')]), []);
  });

  test('同一個目標只帶一次', () => {
    const carried = carryLinks('output', [link('supports', '1', 'thinking'), link('related', '1', 'thinking')]);
    assert.deepEqual(carried.map((c) => [c.rel, c.to]), [['related', '1']]);
  });

  const unescape = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  /** 表單上那顆按鈕帶的列；沒有按鈕就是 null。 */
  const carryOf = (html: string) => {
    const raw = html.match(/id="carrylinks"\s+data-links='([^']*)'/)?.[1];
    return raw === undefined ? null : (JSON.parse(unescape(raw)) as { rel: string; to: string; title: string }[]);
  };

  /** 截圖裡的情境：今天的 todo 從昨天那張「更新」出來，昨天那張連著進行中的事。 */
  async function todoChain(h: Harness) {
    const task = await createCard(h, { type: 'thinking', title: '國文現代小說第二次作業' });
    const frag = await createCard(h, { type: 'fleeting', title: '兩個進行到一半的對話串' });
    const before = await createCard(h, { type: 'thinking', title: '11/4 todo' });
    const yesterday = await createCard(h, {
      type: 'thinking',
      title: '11/5 todo',
      links: [
        { rel: 'related', to: task },
        { rel: 'related', to: frag },
        { rel: 'updates', to: before },
      ],
    });
    return { task, frag, before, yesterday };
  }

  test('從卡片頁 + 進來：按鈕帶著原卡的連結，原卡更新的那張不帶', async () => {
    const h = await fresh();
    const { task, frag, yesterday } = await todoChain(h);

    const html = await get(h, `/new?type=thinking&rel=updates&to=${yesterday}`);
    const carried = carryOf(html);
    assert.ok(carried);
    assert.deepEqual(
      carried.map((c) => [c.rel, c.to, c.title]).sort(),
      [
        ['related', frag, '兩個進行到一半的對話串'],
        ['related', task, '國文現代小說第二次作業'],
      ].sort(),
    );
    assert.match(html, /帶入原卡的 <span data-count>2<\/span> 條連結/);
    // 按鈕不取代指向原卡的那一條固定列。
    assert.match(html, new RegExp(`class="linkrow fixed rel-updates">[\\s\\S]*?name="link_to" value="${yesterday}"`));
  });

  test('帶進來的關係送得出去', async () => {
    const h = await fresh();
    const { yesterday } = await todoChain(h);
    const carried = carryOf(await get(h, `/new?type=thinking&rel=updates&to=${yesterday}`)) ?? [];
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: {
        type: 'thinking',
        title: '11/6 todo',
        tags: ['todo'],
        links: [{ rel: 'updates', to: yesterday }, ...carried.map((c) => ({ rel: c.rel, to: c.to }))],
      },
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(res.statusCode, 302, res.body);
  });

  test('沒有按鈕：裸的 /new、原卡沒有連結', async () => {
    const h = await fresh();
    const lone = await createCard(h, { type: 'thinking', title: '沒有連結的卡' });
    assert.equal(carryOf(await get(h, '/new')), null);
    const html = await get(h, `/new?type=thinking&rel=related&to=${lone}`);
    assert.ok(html.includes('id="sourcepane"'));
    assert.ok(!html.includes('id="carrylinks"'));
  });

  test('驗證失敗退回時按鈕還在', async () => {
    const h = await fresh();
    const { task, yesterday } = await todoChain(h);
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: new URLSearchParams({
        type: 'thinking',
        title: '',
        body: '- [ ] 甲',
        reply_to: yesterday,
        link_rel: 'updates',
        link_to: yesterday,
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(carryOf(res.body)?.some((c) => c.to === task));
  });

  test('沒有 JS 不顯示按鈕', () => {
    assert.match(css('form'), /html:not\(\.js\) \.carrylinks \{ display: none; \}/);
  });
});
