import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import vm from 'node:vm';
import { cardText, formFields, isUntitled, sourceFields, withCardText } from '../src/domain/card.ts';
import { validateDraft } from '../src/domain/rules.ts';
import { supersededMarks } from '../src/web/present.ts';
import { createCard, makeWorkspace, start, type Harness } from './helpers.ts';

/** v3.3 規格（spec/Append_cards_v3.3_spec.md）。 */

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

async function fresh(): Promise<Harness> {
  const h = await start(makeWorkspace());
  cleanups.push(h.close);
  return h;
}

const get = async (h: Harness, url: string) => (await h.app.fastify.inject(url)).body;

const css = (name: string) => fs.readFileSync(path.join('public', 'css', `${name}.css`), 'utf8');
const js = (name: string) => fs.readFileSync(path.join('public', 'js', `${name}.js`), 'utf8');

// ---------------------------------------------------------------- §1

describe('§1 編輯頁的複製與下載', () => {
  test('跟卡片頁同一組按鈕，指向這一頁的文字框；碎片指向它那一個大文字框', async () => {
    const h = await fresh();
    const t = await createCard(h, { type: 'thinking', title: '一則思考', body: 'x' });
    const page = await get(h, `/c/${t}/edit`);
    assert.match(page, /id="copybtn"[^>]*data-for="bodytext"/);
    assert.match(page, new RegExp(`id="dlbtn"[^>]*data-for="bodytext"[^>]*data-file="${t}\\.md"`));
    assert.match(page, /src="\/static\/js\/copy\.js[^"]*"/);
    assert.match(page, /src="\/static\/js\/download\.js[^"]*"/);
    // 按鈕在 meta 行裡，排在倒數後面。
    const meta = page.slice(page.indexOf('<p class="cardmeta">'), page.indexOf('</p>', page.indexOf('<p class="cardmeta">')));
    assert.ok(meta.indexOf('class="lock') < meta.indexOf('class="cardtools"'));

    const f = await createCard(h, { type: 'fleeting', title: '一句話' });
    assert.match(await get(h, `/c/${f}/edit`), /id="copybtn"[^>]*data-for="singletext"/);
  });

  test('倒數與按鈕綁成一段推到行末，折行時一起靠右', async () => {
    const h = await fresh();
    const t = await createCard(h, { type: 'thinking', title: '一則思考', body: 'x' });
    assert.match(await get(h, `/c/${t}/edit`), /<span class="metaend">\s*<span class="lock[\s\S]*?class="cardtools"/);
    const rule = /\.metaend \{([^}]*)\}/.exec(css('form'))?.[1] ?? '';
    assert.match(rule, /margin-left: auto/);
    assert.match(rule, /justify-content: flex-end/);
  });

  /** 在 vm 裡跑那支腳本，DOM 只做到它碰得到的那幾個東西。 */
  function load(file: 'copy' | 'download', opts: { title: string | null; file?: string }) {
    let click: (() => void) | null = null;
    const btn = {
      dataset: { for: 'bodytext', file: opts.file ?? '123.md' },
      classList: { add() {}, remove() {} },
      addEventListener: (_: string, fn: () => void) => {
        click = fn;
      },
    };
    const field = {
      value: '',
      form: {
        elements: {
          namedItem: (n: string) => (n === 'title' && opts.title !== null ? { value: opts.title } : null),
        },
      },
    };
    const out: { copied?: string; blob?: string; download?: string } = {};
    const sandbox = {
      document: {
        getElementById: (id: string) => (id === 'copybtn' || id === 'dlbtn' ? btn : id === 'bodytext' ? field : null),
        querySelector: () => null,
        createElement: () => ({
          click() {},
          remove() {},
          set download(v: string) {
            out.download = v;
          },
        }),
        body: { appendChild() {} },
      },
      navigator: {
        clipboard: {
          writeText: (t: string) => {
            out.copied = t;
            return Promise.resolve();
          },
        },
      },
      Blob: class {
        constructor(parts: string[]) {
          out.blob = parts.join('');
        }
      },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
    };
    vm.runInNewContext(js(file), sandbox);
    return {
      field,
      out,
      click: () => {
        assert.ok(click, '按鈕上要有監聽');
        (click as () => void)();
      },
    };
  }

  test('複製的是按下去當下文字框的內容，包含還沒存的修改', () => {
    const p = load('copy', { title: '標題' });
    p.field.value = '載入之後才打的字';
    p.click();
    assert.equal(p.out.copied, '載入之後才打的字');
  });

  test('下載用表單上當下的標題當檔名與 `# 標題`；碎片的表單沒有標題欄，用 ID', () => {
    const t = load('download', { title: ' 改過的標題 ' });
    t.field.value = '內文';
    t.click();
    assert.equal(t.out.blob, '# 改過的標題\n\n內文\n');
    assert.equal(t.out.download, '改過的標題.md');

    const f = load('download', { title: null, file: '999.md' });
    f.field.value = '一句話';
    f.click();
    assert.equal(f.out.blob, '一句話\n');
    assert.equal(f.out.download, '999.md');
  });
});

// ---------------------------------------------------------------- §2

describe('§2 更新時帶入原卡內容', () => {
  /** 表單上某個單行欄位的值。 */
  const input = (page: string, name: string) =>
    new RegExp(`<input type="(?:text|url)" name="${name}"[^>]*value="([^"]*)"`).exec(page)?.[1];
  const body = (page: string) => /<textarea name="body" id="bodytext"[^>]*>([\s\S]*?)<\/textarea>/.exec(page)?.[1];

  test('思考的更新：標題、內文、網址、標籤照原卡帶入，表單標成有預填', async () => {
    const h = await fresh();
    const old = await createCard(h, {
      type: 'thinking',
      title: '舊的主張',
      body: '第一段\n\n- [x] 做完的',
      url: 'https://example.com/a',
      tags: ['世界觀', '設定'],
    });
    const page = await get(h, `/new?type=thinking&rel=updates&to=${old}`);
    assert.equal(input(page, 'title'), '舊的主張');
    assert.equal(body(page), '第一段\n\n- [x] 做完的');
    assert.equal(input(page, 'url'), 'https://example.com/a');
    assert.equal(input(page, 'tags'), '世界觀 設定');
    assert.match(page, /data-draft-prefilled/, '草稿不靜默覆蓋（v2.2）');
  });

  test('連結不帶，留給「帶入原卡的連結」', async () => {
    const h = await fresh();
    const src = await createCard(h, { type: 'original', title: '一份資料' });
    const old = await createCard(h, { type: 'thinking', title: '舊的主張', links: [{ rel: 'about', to: src }] });
    const page = await get(h, `/new?type=thinking&rel=updates&to=${old}`);
    assert.match(page, new RegExp(`name="link_to" value="${old}"`));
    assert.doesNotMatch(page, new RegExp(`name="link_to" value="${src}"`));
    assert.match(page, /id="carrylinks"/, '按鈕照樣在');
  });

  test('資料的更新另外帶出處；產出的更新一樣帶標題與內文', async () => {
    const h = await fresh();
    const doc = await createCard(h, {
      type: 'original',
      title: '一份資料',
      body: '原文',
      url: 'https://example.com/doc',
      source_author: '某人',
      source_date: '1962',
      provenance: 'translated',
    });
    const page = await get(h, `/new?type=original&rel=updates&to=${doc}`);
    assert.equal(input(page, 'title'), '一份資料');
    assert.equal(body(page), '原文');
    assert.equal(input(page, 'url'), 'https://example.com/doc');
    assert.equal(input(page, 'source_author'), '某人');
    assert.equal(input(page, 'source_date'), '1962');
    assert.match(page, /<option value="translated" selected>/);

    const out = await createCard(h, { type: 'output', title: '短篇', body: '第一版' });
    const next = await get(h, `/new?type=output&rel=updates&to=${out}`);
    assert.equal(input(next, 'title'), '短篇');
    assert.equal(body(next), '第一版');
  });

  test('完整化照舊：碎片那段話進內文，標題空著', async () => {
    const h = await fresh();
    const f = await createCard(h, { type: 'fleeting', title: '隨口一句' });
    const page = await get(h, `/new?type=thinking&rel=updates&to=${f}`);
    assert.equal(input(page, 'title'), '');
    assert.equal(body(page), '隨口一句');
  });

  test('反駁不帶：那是另一個主張', async () => {
    const h = await fresh();
    const old = await createCard(h, { type: 'thinking', title: '舊的主張', body: '內文' });
    const page = await get(h, `/new?type=thinking&rel=refutes&to=${old}`);
    assert.equal(input(page, 'title'), '');
    assert.equal(body(page), '');
  });
});

// ---------------------------------------------------------------- §3

/** 某一列：從標題往回找到那一列的 <li>，往後到 </li>。標記排在標題前面（§5）。 */
function rowOf(s: string, title: string): string {
  const at = s.indexOf(`${title}</a>`);
  assert.ok(at > -1, `找不到「${title}」`);
  return s.slice(s.lastIndexOf('<li', at), s.indexOf('</li>', at));
}

describe('§3 引用串標出已被取代的卡', () => {
  /** 卡片頁某個方向的引用串。 */
  const stream = (page: string, dir: 'up' | 'down') => {
    const at = page.indexOf(`<div class="stream ${dir}">`);
    return at === -1 ? '' : page.slice(at, page.indexOf('</ul>', at));
  };

  test('上游：指向的那張已被更新，那一列標「已被更新」', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '舊的主張' });
    const b = await createCard(h, { type: 'thinking', title: '延伸', links: [{ rel: 'related', to: a }] });
    await createCard(h, { type: 'thinking', title: '新的主張', links: [{ rel: 'updates', to: a }] });

    assert.match(rowOf(stream(await get(h, `/c/${b}`), 'up'), '舊的主張'), /<span class="supmark">已被更新<\/span>/);
  });

  test('新版本自己的頁面上，「更新自 舊版」那一列不再標一次；別人反駁了它照樣標', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '舊的主張' });
    const a2 = await createCard(h, { type: 'thinking', title: '新的主張', links: [{ rel: 'updates', to: a }] });

    assert.doesNotMatch(rowOf(stream(await get(h, `/c/${a2}`), 'up'), '舊的主張'), /supmark/);

    await createCard(h, { type: 'thinking', title: '反駁', links: [{ rel: 'refutes', to: a }] });
    const marks = rowOf(stream(await get(h, `/c/${a2}`), 'up'), '舊的主張');
    assert.match(marks, /<span class="supmark">已被反駁<\/span>/);
    assert.doesNotMatch(marks, /已被更新/);
  });

  test('下游也標；新版本那一列沒有被取代，不標', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '起點' });
    const b = await createCard(h, { type: 'thinking', title: '延伸', links: [{ rel: 'related', to: a }] });
    await createCard(h, { type: 'thinking', title: '延伸的新版', links: [{ rel: 'updates', to: b }] });

    const down = stream(await get(h, `/c/${a}`), 'down');
    assert.match(rowOf(down, '延伸'), /<span class="supmark">已被更新<\/span>/);
    assert.doesNotMatch(rowOf(down, '延伸的新版'), /supmark/);
  });

  test('碎片被完整化說「已完整化」；牴觸不算', async () => {
    const h = await fresh();
    const f = await createCard(h, { type: 'fleeting', title: '隨口一句' });
    const t = await createCard(h, { type: 'thinking', title: '接著想', links: [{ rel: 'related', to: f }] });
    await createCard(h, { type: 'thinking', title: '完整的版本', links: [{ rel: 'updates', to: f }] });
    assert.match(rowOf(stream(await get(h, `/c/${t}`), 'up'), '隨口一句'), /<span class="supmark">已完整化<\/span>/);

    const c = await createCard(h, { type: 'thinking', title: '一個主張' });
    const d = await createCard(h, { type: 'thinking', title: '延伸', links: [{ rel: 'related', to: c }] });
    await createCard(h, { type: 'thinking', title: '不相容', links: [{ rel: 'contradicts', to: c }] });
    assert.doesNotMatch(rowOf(stream(await get(h, `/c/${d}`), 'up'), '一個主張'), /supmark/);
  });

  test('兩種都有時兩個都列，更新在前；說法用被動', () => {
    assert.deepEqual(supersededMarks('thinking', ['refutes', 'updates']), ['已被更新', '已被反駁']);
    assert.deepEqual(supersededMarks('fleeting', ['updates']), ['已完整化']);
    assert.deepEqual(supersededMarks('thinking', []), []);
  });

  test('顏色跟卡片頁頂端的提示同一組', () => {
    const rule = /\.supmark \{([^}]*)\}/.exec(css('base'))?.[1] ?? '';
    assert.match(rule, /background: var\(--superseded-bg\)/);
    assert.match(rule, /color: var\(--alert\)/);
  });
});

// ---------------------------------------------------------------- §5

describe('§5 搜尋結果與「已隱藏」也標；標記與環境名排在標題前面', () => {
  const enc = encodeURIComponent;
  const newEnv = (h: Harness, name: string) =>
    h.app.fastify.inject({
      method: 'POST',
      url: '/envs',
      payload: `name=${enc(name)}&from=`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  async function cardIn(h: Harness, env: string, payload: Record<string, unknown>): Promise<string> {
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: `/e/${enc(env)}/new`,
      payload,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    assert.equal(res.statusCode, 302, res.body);
    return (res.json() as { id: string }).id;
  }
  /** 結果清單本身。 */
  const rows = (page: string) => {
    const at = page.indexOf('<ul class="rows">');
    return at === -1 ? '' : page.slice(at, page.indexOf('</ul>', at));
  };

  test('搜尋結果：已被更新、已被反駁各自標出；還成立的不標', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '關鍵字的舊版' });
    await createCard(h, { type: 'thinking', title: '關鍵字的新版', links: [{ rel: 'updates', to: a }] });
    const r = await createCard(h, { type: 'thinking', title: '關鍵字被推翻的' });
    await createCard(h, { type: 'thinking', title: '反駁它', links: [{ rel: 'refutes', to: r }] });

    const list = rows(await get(h, `/search?q=${enc('關鍵字')}`));
    assert.match(rowOf(list, '關鍵字的舊版'), /<span class="supmark">已被更新<\/span>\s*<a class="rowtitle"/);
    assert.match(rowOf(list, '關鍵字被推翻的'), /<span class="supmark">已被反駁<\/span>\s*<a class="rowtitle"/);
    assert.doesNotMatch(rowOf(list, '關鍵字的新版'), /supmark/);
  });

  test('「已隱藏」那一頁也標，分得出是被更新還是被反駁；一般的時間軸沒有標記', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '舊的主張' });
    await createCard(h, { type: 'thinking', title: '新的主張', links: [{ rel: 'updates', to: a }] });
    const r = await createCard(h, { type: 'thinking', title: '錯的主張' });
    await createCard(h, { type: 'thinking', title: '反駁它', links: [{ rel: 'refutes', to: r }] });

    const hidden = rows(await get(h, '/?hidden=1'));
    assert.match(rowOf(hidden, '舊的主張'), /<span class="supmark">已被更新<\/span>/);
    assert.match(rowOf(hidden, '錯的主張'), /<span class="supmark">已被反駁<\/span>/);
    assert.doesNotMatch(rows(await get(h, '/')), /supmark/);
  });

  test('碎片沒有標題，標記排在日期前面', async () => {
    const h = await fresh();
    const f = await createCard(h, { type: 'fleeting', title: '關鍵字的一句話' });
    await createCard(h, { type: 'thinking', title: '完整的版本', links: [{ rel: 'updates', to: f }] });
    const list = rows(await get(h, `/search?q=${enc('一句話')}`));
    assert.match(list, /<p class="rowhead">\s*<span class="supmark">已完整化<\/span>\s*<time/);
  });

  test('順序是「已被更新」、環境名、標題：清單、引用串、頂端的提示都一樣', async () => {
    const h = await fresh();
    await newEnv(h, '繪圖');
    await newEnv(h, '學校');
    const old = await cardIn(h, '學校', { type: 'thinking', title: '關鍵字的舊版', tags: ['測試'] });
    const ref = await cardIn(h, '繪圖', {
      type: 'thinking',
      title: '從繪圖連過去',
      tags: ['測試'],
      links: [{ rel: 'related', to: old }],
    });
    const next = await cardIn(h, '繪圖', {
      type: 'thinking',
      title: '別處的新版',
      tags: ['測試'],
      links: [{ rel: 'updates', to: old }],
    });

    // 清單：搜尋所有環境。環境名從 meta 行搬到標題前面。
    const list = rows(await get(h, `/e/${enc('繪圖')}/search?q=${enc('關鍵字')}&all=1`));
    const row = rowOf(list, '關鍵字的舊版');
    assert.match(row, /<span class="supmark">已被更新<\/span>\s*<span class="envmark">學校<\/span>\s*<a class="rowtitle"/);
    assert.doesNotMatch(row.slice(row.indexOf('<p class="rowmeta">')), /envmark/, 'meta 行不再有環境名');

    // 引用串。
    const up = rowOf(await get(h, `/c/${ref}`), '關鍵字的舊版');
    assert.match(
      up,
      /<span class="supmark">已被更新<\/span>\s*<span class="envmark">學校<\/span>\s*<span class="tname">思考<\/span>\s*<a class="nodetitle"/,
    );

    // 卡片頁頂端的提示：環境名在標題前面。
    const page = await get(h, `/c/${old}`);
    const at = page.indexOf('<div class="superseded">');
    const box = page.slice(at, page.indexOf('</div>', at));
    assert.match(box, new RegExp(`<span class="envmark">繪圖</span><a href="/c/${next}">別處的新版</a>`));
  });

  test('連結的選卡器：環境名排在標題前面', () => {
    const src = js('links');
    const envAt = src.indexOf("env.className = 'envmark'");
    const titleAt = src.indexOf('createTextNode(r.title)');
    assert.ok(envAt > -1 && titleAt > envAt);
    assert.match(css('form'), /\.picker \.envmark, \.picker \.supmark \{ margin-right: var\(--sp-1\); \}/);
  });
});

describe('§5.4 標題換行：清單接在標記後面，窄螢幕的引用串自己一行', () => {
  test('清單：標記、環境名、標題在同一段文字裡，由那一段截兩行', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '關鍵字的舊版' });
    await createCard(h, { type: 'thinking', title: '新版', links: [{ rel: 'updates', to: a }] });
    const page = await get(h, `/search?q=${encodeURIComponent('關鍵字')}`);
    assert.match(page, /<span class="rowheading"><span class="supmark">已被更新<\/span><a class="rowtitle"[^>]*>關鍵字的舊版<\/a><\/span>/);
    const heading = /\.rowheading \{([^}]*)\}/.exec(css('list'))?.[1] ?? '';
    assert.match(heading, /-webkit-line-clamp: 2/);
    assert.match(css('list'), /\.rowheading \.supmark,\s*\.rowheading \.envmark \{[^}]*display: inline-block/);
  });

  test('引用串：型別名在連結外面；寬螢幕補冒號，窄螢幕標題換到第二行、不截斷', () => {
    const card = css('card');
    assert.match(card, /\.nodebody \.tname::after \{ content: "："; \}/);
    const narrow = /@media \(max-width: 35\.99rem\) \{([\s\S]*?)\n\}/.exec(card)?.[1] ?? '';
    assert.match(narrow, /\.nodetitle \{[^}]*order: 1;[^}]*flex-basis: 100%;[^}]*white-space: normal;/);
    assert.match(narrow, /\.nodebody::before \{[^}]*height: var\(--rail-h\)/, '第一行固定一列高，色點與分枝對得上');
    assert.match(narrow, /\.stream\.up \.rail-tee::after,\s*\.stream\.up \.rail-elbow::after \{ top: auto; bottom: calc\(var\(--rail-h\) \/ 2\); \}/);
  });
});

// ---------------------------------------------------------------- §7

describe('§7 Enter 之後重排編號', () => {
  interface Edit {
    from: number;
    to: number;
    text: string;
    selStart: number;
    selEnd: number;
  }
  const sandbox: { window: { skynoteMd?: { enter(v: string, s: number, e: number): Edit | null } } } = { window: {} };
  vm.runInNewContext(js('mdbar'), sandbox);
  const md = sandbox.window.skynoteMd as { enter(v: string, s: number, e: number): Edit | null };

  // 游標寫成 |（同 v3.2 的 §4 測試）。
  const enter = (input: string) => {
    const s = input.indexOf('|');
    const value = input.replace('|', '');
    const ed = md.enter(value, s, s);
    if (!ed) return null;
    const out = value.slice(0, ed.from) + ed.text + value.slice(ed.to);
    return out.slice(0, ed.selStart) + '|' + out.slice(ed.selStart);
  };

  test('在中間插一項，同一層後面的編號往後順延', () => {
    assert.equal(enter('1. 甲|\n2. 乙\n3. 丙'), '1. 甲\n2. |\n3. 乙\n4. 丙');
    assert.equal(enter('1. 甲|乙\n2. 丙'), '1. 甲\n2. |乙\n3. 丙', '游標在字中間：後半段成為新的一項');
    assert.equal(enter('9) 甲|\n10) 乙'), '9) 甲\n10) |\n11) 乙', '括號的編號');
    assert.equal(enter('1. [ ] 甲|\n2. [x] 乙'), '1. [ ] 甲\n2. [ ] |\n3. [x] 乙', '待辦的方框原樣留著');
    assert.equal(enter('> 1. 甲|\n> 2. 乙'), '> 1. 甲\n> 2. |\n> 3. 乙', '引言裡的清單');
  });

  test('子清單、縮排的續行、空行跳過；編號已經對的不動', () => {
    assert.equal(enter('1. 甲|\n   - 子\n   續行\n2. 乙'), '1. 甲\n2. |\n   - 子\n   續行\n3. 乙');
    assert.equal(enter('1. 甲|\n\n2. 乙'), '1. 甲\n2. |\n\n3. 乙');
    assert.equal(enter('1. 甲|\n3. 乙'), '1. 甲\n2. |\n3. 乙', '後面本來就是 3，不必改');
  });

  test('清單結束的地方停下來：一般文字、換成 - 清單、換了分隔符號、縮排變淺', () => {
    assert.equal(enter('1. 甲|\n2. 乙\n\n文字\n\n3. 別的'), '1. 甲\n2. |\n3. 乙\n\n文字\n\n3. 別的');
    assert.equal(enter('1. 甲|\n- 乙\n2. 丙'), '1. 甲\n2. |\n- 乙\n2. 丙');
    assert.equal(enter('1. 甲|\n2) 乙'), '1. 甲\n2. |\n2) 乙');
    assert.equal(
      enter('1. 外\n   1. 內|\n   2. 內二\n2. 外二'),
      '1. 外\n   1. 內\n   2. |\n   3. 內二\n2. 外二',
      '只動同一層：外層的編號不受影響',
    );
  });

  test('插入與重排是同一次替換，Ctrl+Z 一次就整個退回去', () => {
    const value = '1. 甲\n2. 乙';
    const ed = md.enter(value, 4, 4) as Edit;
    assert.equal(ed.from, 4);
    assert.equal(ed.to, value.length);
    assert.equal(ed.text, '\n2. \n3. 乙');
  });

  test('項目符號清單不受影響', () => {
    assert.equal(enter('- 甲|\n- 乙'), '- 甲\n- |\n- 乙');
  });
});

// ---------------------------------------------------------------- §6

describe('§6 資料可以只貼一段文字（R16）', () => {
  const deps = { cardExists: () => false, typeOf: () => null };
  const draft = (over: Record<string, unknown>) => ({
    type: 'original',
    title: '',
    body: '',
    tags: [],
    url: null,
    provenance: null,
    links: [],
    ...over,
  });
  const put = (h: Harness, id: string, payload: object) =>
    h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${id}`,
      payload,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
  const fileOf = (h: Harness, id: string) => path.join(h.corpus, 'cards', `${id}.md`);

  test('R16：資料的內文必填、標題選填；其他型別照舊要標題', () => {
    assert.deepEqual(validateDraft(draft({ body: '一段文字' }), deps).errors, []);
    assert.deepEqual(validateDraft(draft({ title: '有標題', body: '內文' }), deps).errors, []);
    assert.deepEqual(validateDraft(draft({ title: '只有標題' }), deps).errors, ['資料的內文不得為空']);
    assert.deepEqual(validateDraft(draft({ body: '   ' }), deps).errors, ['資料的內文不得為空']);
    assert.deepEqual(validateDraft(draft({ type: 'output', body: '內文' }), deps).errors, ['標題不得為空']);
  });

  test('欄位反轉：沒填標題的資料，那段文字存進 title、body 留空；有標題的照舊', () => {
    assert.deepEqual(sourceFields('', '  一段文字\n'), { title: '一段文字', body: '' });
    assert.deepEqual(sourceFields('標題', '內文'), { title: '標題', body: '內文' });

    const untitled = { type: 'original', title: '一段文字', body: '' };
    assert.equal(isUntitled(untitled), true);
    assert.equal(isUntitled({ type: 'original', body: '內文' }), false);
    assert.equal(isUntitled({ type: 'fleeting', body: '' }), true);
    assert.equal(isUntitled({ type: 'thinking', body: '' }), false, '只有資料與碎片');
    assert.deepEqual(formFields(untitled), { title: '', body: '一段文字' });
    assert.equal(cardText(untitled), '一段文字');
    assert.deepEqual(withCardText(untitled, '- [x] 一段文字'), { ...untitled, title: '- [x] 一段文字' }, '勾選改的是 title');
  });

  test('只貼一段文字：存得進去，卡片頁沒有大標題，那段文字當內文排', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '', body: '看到的一段情報\n第二行', source_author: '某人' });
    // 存檔：那段文字在 title、body 留空（檔案寫得進去也讀得回來，索引是從檔案重建的）。
    assert.ok(fs.existsSync(fileOf(h, id)));
    assert.equal(h.app.index.getCard(id)?.title, '看到的一段情報\n第二行');
    assert.equal(h.app.index.getCard(id)?.body, '');

    const page = await get(h, `/c/${id}`);
    assert.doesNotMatch(page.slice(page.indexOf('<article')), /<h1/, '沒有大標題');
    assert.match(page, /<div class="body"[^>]*data-md="看到的一段情報\n第二行"/);
    assert.doesNotMatch(page, /class="body"[^>]*data-title=/, '下載不加 # 標題');
    assert.match(page, new RegExp(`id="dlbtn"[^>]*data-file="${id}\\.md"`));
    assert.match(page, /<span class="tname">資料<\/span>/);
  });

  test('時間軸：沒有標題的資料照碎片的方式列那段文字；有標題的照舊只列出處', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '', body: '沒有標題的那段', source_author: '某人', source_date: '2020' });
    await createCard(h, { type: 'original', title: '有標題的資料', body: '不該出現在列表上' });
    const rows = (await get(h, '/')).split('<li class="row');
    const untitled = rows.find((r) => r.includes('沒有標題的那段')) ?? '';
    assert.match(untitled, /^ untitled"/);
    assert.match(untitled, /<a class="rowtext rowbody rowlines"[^>]*>沒有標題的那段<\/a>/);
    assert.ok(untitled.includes('某人 · 2020'), '出處照樣列');
    const titled = rows.find((r) => r.includes('有標題的資料')) ?? '';
    assert.ok(titled.includes('class="rowtitle"') && !titled.includes('不該出現在列表上'));
  });

  test('建立表單：資料的標題不必填、內文必填；其他型別照舊', async () => {
    const h = await fresh();
    const form = await get(h, '/new?type=original');
    assert.match(form, /<input type="text" name="title" autocomplete="off" value=""\s*placeholder="可以不填">/);
    assert.match(form, /<textarea name="body" id="bodytext" rows="14" spellcheck="false" required data-mdbar>/);
    const other = await get(h, '/new?type=thinking');
    assert.match(other, /<input type="text" name="title" autocomplete="off" value=""\s*required>/);
    assert.match(other, /<textarea name="body" id="bodytext" rows="14" spellcheck="false" data-mdbar>/);
    // 換型別時前端照同一張表重設必填（bare /new 的型別選單）。
    assert.match(js('typefields'), /c\.required = on && !spec\.optionalTitle;/);
    assert.match(js('typefields'), /if \(c\.name === 'body'\) c\.required = on && spec\.optionalTitle;/);
  });

  test('編輯頁：標題欄空著、那段文字在內文欄；補上標題就變回有標題的資料', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '', body: '一段文字' });
    const edit = await get(h, `/c/${id}/edit`);
    assert.match(edit, /<input type="text" name="title" autocomplete="off" value=""\s*placeholder="可以不填">/);
    assert.match(edit, /<textarea name="body" id="bodytext"[^>]*required data-mdbar>一段文字<\/textarea>/);

    // 只改內文：還是沒有標題。
    assert.equal((await put(h, id, { title: '', body: '改過的文字' })).statusCode, 200);
    assert.equal(h.app.index.getCard(id)?.title, '改過的文字');
    assert.equal(h.app.index.getCard(id)?.body, '');

    // 補上標題。
    assert.equal((await put(h, id, { title: '補上的標題', body: '改過的文字' })).statusCode, 200);
    assert.equal(h.app.index.getCard(id)?.title, '補上的標題');
    assert.equal(h.app.index.getCard(id)?.body, '改過的文字');

    // 內文清空：擋下來。
    const empty = await put(h, id, { title: '補上的標題', body: '' });
    assert.equal(empty.statusCode, 400);
    assert.ok(empty.body.includes('資料的內文不得為空'));

    // 只改標籤（沒帶標題與內文）：照原樣留著。
    assert.equal((await put(h, id, { tags: ['x'] })).statusCode, 200);
    assert.equal(h.app.index.getCard(id)?.title, '補上的標題');
  });

  test('「更新」一張沒有標題的資料：標題欄空著，那段文字帶進內文', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '', body: '舊的一段' });
    const page = await get(h, `/new?type=original&rel=updates&to=${id}`);
    assert.match(page, /<input type="text" name="title" autocomplete="off" value=""/);
    assert.match(page, /<textarea name="body" id="bodytext"[^>]*>舊的一段<\/textarea>/);
  });

  test('被引用時，引用串列出那段文字', async () => {
    const h = await fresh();
    const src = await createCard(h, { type: 'original', title: '', body: '一段外來的情報' });
    const t = await createCard(h, { type: 'thinking', title: '想法', links: [{ rel: 'about', to: src }] });
    assert.match(await get(h, `/c/${t}`), /<a class="nodetitle"[^>]*>一段外來的情報<\/a>/);
  });
});

// ---------------------------------------------------------------- §11

describe('§11.1 換行之後，框跟著游標捲', () => {
  test('工具列改完字、放好游標之後，把游標那一行捲進框裡', () => {
    assert.match(js('mdbar'), /ta\.setSelectionRange\(ed\.selStart, ed\.selEnd\);\s*reveal\(ta\);/);
  });

  test('自己打字時，框跟著游標捲也留下上下的內距', () => {
    const form = css('form');
    assert.match(form, /\.field textarea \{[^}]*scroll-padding-block: var\(--sp-2\);/);
    assert.match(form, /\.quick textarea \{[^}]*scroll-padding-block: var\(--sp-2\);/);
  });
});

describe('§11.2 連結的選卡器也標出已被取代的卡', () => {
  test('照樣列，已被更新、已被反駁各自標出；還成立的不標', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: '選卡的舊版' });
    await createCard(h, { type: 'thinking', title: '選卡的新版', links: [{ rel: 'updates', to: a }] });
    const r = await createCard(h, { type: 'thinking', title: '選卡被推翻的' });
    await createCard(h, { type: 'thinking', title: '反駁選卡', links: [{ rel: 'refutes', to: r }] });

    const list = (await h.app.fastify.inject(`/api/search?q=${encodeURIComponent('選卡')}`)).json() as {
      title: string;
      marks: string[];
    }[];
    const marks = (title: string) => list.find((x) => x.title === title)?.marks;
    assert.equal(list.length, 4);
    assert.deepEqual(marks('選卡的舊版'), ['已被更新']);
    assert.deepEqual(marks('選卡被推翻的'), ['已被反駁']);
    assert.deepEqual(marks('選卡的新版'), []);
    assert.deepEqual(marks('反駁選卡'), []);
  });

  test('順序是「已被更新」、環境名、標題，跟引用串與清單一致', () => {
    const src = js('links');
    const markAt = src.indexOf("mark.className = 'supmark'");
    const envAt = src.indexOf("env.className = 'envmark'");
    const titleAt = src.indexOf('createTextNode(r.title)');
    assert.ok(markAt > -1 && envAt > markAt && titleAt > envAt);
  });
});

describe('§11.3 站內的完整網址留在 Ferdium 裡', () => {
  test('按下去之前（window 的捕獲階段）改成站內路徑；別的網站不碰', () => {
    const nav = js('nav');
    assert.match(
      nav,
      /add\.call\(window, 'click', function \(ev\) \{[\s\S]*?if \(u\.origin === location\.origin\) a\.setAttribute\('href', u\.pathname \+ u\.search \+ u\.hash\);\s*\}, true\);/,
    );
  });
});
