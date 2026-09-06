import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fleetingDraft, fleetingText, parseCard, serializeCard } from '../src/domain/card.ts';
import { readCard } from '../src/store/files.ts';
import { renderMarkdown } from '../src/web/render.ts';
import { compareIds, generateId } from '../src/domain/id.ts';
import type { Card } from '../src/domain/types.ts';
import {
  CARD_ACTIONS,
  CARD_TYPES,
  REL_LABELS,
  REL_LABELS_BACK,
  REL_MATRIX,
  REL_TYPES,
  allowedTargets,
} from '../src/domain/types.ts';
import { eta } from '../src/web/render.ts';

/** 直接把一枚圖示渲染出來，確認每條 rel 都畫得出東西。 */
const renderIcon = (name: string): string => eta.render('icon', { name });
import { validateDraft, validateLinkOrder } from '../src/domain/rules.ts';
import { embedFor } from '../src/web/embed.ts';
import { ftsQuery, segmentCjk } from '../src/store/index/index.ts';
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

/** 索引裡這張卡的出向關係，排序過方便比對。 */
function index0(h: Harness, id: string): string[] {
  return h.app.index
    .outLinks(id)
    .map((l) => l.rel)
    .sort();
}

function errorsOf(res: { json(): unknown }): string {
  return ((res.json() as { errors?: string[] }).errors ?? []).join(' | ');
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
    source_author: null,
    source_date: null,
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

describe('第四型與來源欄位', () => {
  const fleeting: Card = {
    id: '1234567890123456789',
    type: 'fleeting',
    created: '2026-09-04T10:00:00.000Z',
    title: '隨口的一句話，整段就是它的全部內容。',
    tags: [],
    url: null,
    provenance: null,
    source_author: null,
    source_date: null,
    revised: null,
    links: [],
    body: '',
  };

  test('fleeting 序列化後再解析，內容完全相同', () => {
    assert.deepEqual(parseCard(serializeCard(fleeting), fleeting.id), fleeting);
  });

  test('fleeting 的文字問 fleetingText，不直接讀欄位', () => {
    assert.equal(fleetingText(fleeting), '隨口的一句話，整段就是它的全部內容。');
    assert.deepEqual(fleetingDraft('  一句話  '), { title: '一句話', body: '' });
  });

  test('source_author / source_date 寫得進檔案也讀得回來', () => {
    const card: Card = {
      ...fleeting,
      type: 'original',
      title: '近可分解系統',
      source_author: 'Herbert A. Simon',
      source_date: '1962',
      body: '內文。\n',
    };
    const text = serializeCard(card);
    assert.ok(text.includes('source_author: Herbert A. Simon'));
    assert.ok(text.includes('source_date: "1962"'), '純數字的年份要帶引號，否則會被讀成數字');
    assert.deepEqual(parseCard(text, card.id), card);
  });

  test('來源欄位是 original 專屬，其他型別送了也不寫進卡片', () => {
    const deps = {
      cardExists: (id: string) => id === '100',
      typeOf: () => 'original' as const,
    };
    const draft = {
      title: 't',
      body: '',
      tags: [],
      url: null,
      provenance: null,
      source_author: 'Simon',
      source_date: '1962',
    };
    const asOriginal = validateDraft({ ...draft, type: 'original', links: [] }, deps);
    assert.equal(asOriginal.value?.source_author, 'Simon');
    assert.equal(asOriginal.value?.source_date, '1962');

    // 每一型都帶著自己合法的連結，才驗得到來源欄位那一段。
    const links: Record<string, { rel: string; to: string }[]> = {
      restatement: [{ rel: 'about', to: '100' }], // R1
      thinking: [],
      fleeting: [], // R2
    };
    for (const [type, ls] of Object.entries(links)) {
      const r = validateDraft({ ...draft, type, links: ls }, deps);
      assert.deepEqual(r.errors, [], `${type} 本身應該是合法的`);
      assert.equal(r.value?.source_author, null, `${type} 不該帶 source_author`);
      assert.equal(r.value?.source_date, null, `${type} 不該帶 source_date`);
    }
  });

  test('part-of 在詞彙表內', () => {
    const deps = { cardExists: (id: string) => id === '100', typeOf: () => 'original' as const };
    const r = validateDraft(
      {
        type: 'original',
        title: 't',
        body: '',
        tags: [],
        url: null,
        provenance: null,
        source_author: null,
        source_date: null,
        links: [{ rel: 'part-of', to: '100' }],
      },
      deps,
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value?.links, [{ rel: 'part-of', to: '100' }]);
  });
});

describe('驗證規則', () => {
  const deps = { cardExists: (id: string) => id === '100', typeOf: () => 'original' as const };

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

describe('型別對連結的約束', () => {
  test('R1：重述必須有一條 about 指向原始資料', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const t = await createCard(h, { type: 'thinking', title: '一個想法', body: 'x' });

    const noLink = await postCard(h, { type: 'restatement', title: '沒有原文可對照', body: 'y' });
    assert.equal(noLink.statusCode, 400);
    assert.match((noLink.json() as { errors: string[] }).errors.join(), /一條 about 指向原始/);

    // about 指向的必須是 original——指向一則思考不算有原文可對照。
    const wrongTarget = await postCard(h, {
      type: 'restatement',
      title: '對著想法重述',
      body: 'y',
      links: [{ rel: 'about', to: t }],
    });
    assert.equal(wrongTarget.statusCode, 400);

    const ok = await postCard(h, {
      type: 'restatement',
      title: '有原文可對照',
      body: 'y',
      links: [{ rel: 'about', to: o }],
    });
    assert.equal(ok.statusCode, 302);
  });

  test('R2：碎片不得有任何連結', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });

    const withLink = await postCard(h, {
      type: 'fleeting',
      title: '一句隨口的話',
      links: [{ rel: 'related', to: o }],
    });
    assert.equal(withLink.statusCode, 400);
    // 問題是「它不該有連結」，不是那條連結哪裡不對——只報一次。
    assert.deepEqual((withLink.json() as { errors: string[] }).errors, ['碎片不能有連結']);

    const bare = await postCard(h, { type: 'fleeting', title: '一句隨口的話' });
    assert.equal(bare.statusCode, 302);
  });

  test('R3：rel 與目標型別都要符合矩陣', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const t = await createCard(h, { type: 'thinking', title: '一個主張', body: 'x' });

    // 這一型根本不能用這條 rel
    const relNotAllowed = await postCard(h, {
      type: 'original',
      title: '原始資料不能 supports',
      body: 'x',
      links: [{ rel: 'supports', to: o }],
    });
    assert.equal(relNotAllowed.statusCode, 400);
    assert.match((relNotAllowed.json() as { errors: string[] }).errors.join(), /不能用 supports/);

    // rel 對，但目標型別不對：refutes 只能指向思考或碎片
    const wrongTarget = await postCard(h, {
      type: 'thinking',
      title: '推翻一份原始資料',
      body: 'x',
      links: [{ rel: 'refutes', to: o }],
    });
    assert.equal(wrongTarget.statusCode, 400);
    assert.match(
      (wrongTarget.json() as { errors: string[] }).errors.join(),
      /不能用 refutes 指向資料/,
    );

    const ok = await postCard(h, {
      type: 'thinking',
      title: '推翻一則思考',
      body: 'x',
      links: [{ rel: 'refutes', to: t }],
    });
    assert.equal(ok.statusCode, 302);
  });

  test('part-of 只給 original 指向 original', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '母文件', body: 'x' });
    const excerpt = await postCard(h, {
      type: 'original',
      title: '節錄的那幾段',
      body: 'x',
      links: [{ rel: 'part-of', to: o }],
    });
    assert.equal(excerpt.statusCode, 302);

    const fromThinking = await postCard(h, {
      type: 'thinking',
      title: '思考不能 part-of',
      body: 'x',
      links: [{ rel: 'part-of', to: o }],
    });
    assert.equal(fromThinking.statusCode, 400);
  });

  test('R4：違反現行規則的既有卡片列入警告，不阻斷重建也不消失', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });

    // 直接寫一張「照今天的規則建立不出來」的卡：重述卻沒有 about。
    // 這模擬的是規則收緊之前就存在的卡片。
    const legacy: Card = {
      id: String(BigInt(o) + 1n),
      type: 'restatement',
      created: new Date().toISOString(),
      title: '規則收緊前就存在的重述',
      tags: [],
      url: null,
      provenance: null,
      source_author: null,
      source_date: null,
      revised: null,
      links: [],
      body: '內容還在。',
    };
    fs.writeFileSync(
      path.join(h.corpus, 'cards', `${legacy.id}.md`),
      serializeCard(legacy),
      'utf8',
    );

    const res = await h.app.fastify.inject({ method: 'POST', url: '/_reindex' });
    const report = res.json() as {
      indexed: number;
      failures: unknown[];
      warnings: { card_id: string; message: string }[];
    };

    assert.equal(report.failures.length, 0, '規則違反不是解析失敗');
    assert.equal(report.indexed, 2, '違反規則的卡片仍然要進索引');
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0]?.card_id, legacy.id);
    assert.match(report.warnings[0]?.message ?? '', /一條 about 指向原始/);

    // 最要緊的一條：它沒有從系統裡消失。
    const page = await h.app.fastify.inject(`/c/${legacy.id}`);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('規則收緊前就存在的重述'));
  });

  test('目標不存在時只報一次，不連帶報矩陣不符', async () => {
    const h = await fresh();
    const res = await postCard(h, {
      type: 'restatement',
      title: 'x',
      body: 'y',
      links: [{ rel: 'about', to: '1' }],
    });
    assert.equal(res.statusCode, 400);
    const errors = (res.json() as { errors: string[] }).errors;
    assert.deepEqual(errors, ['第 1 條連結：目標不存在'], '同一個問題不該報兩次');
  });
});

/** 樣式依職責分了六支檔，斷言一律看合起來的全文。 */
const CSS_FILES = ['tokens', 'base', 'shell', 'list', 'card', 'form'];
function readCss(): string {
  return CSS_FILES.map((f) => fs.readFileSync(path.join('public', 'css', `${f}.css`), 'utf8')).join(
    '\n',
  );
}

/** 側欄的「最近卡片」也列標題，所以清單的斷言只看主內容區。 */
function main(res: { body: string }): string {
  return res.body.slice(res.body.indexOf('<main>'), res.body.indexOf('</main>'));
}

describe('兩張表要對得上', () => {
  test('每一顆動作按鈕產生的組合都在 rel 矩陣裡', () => {
    for (const from of CARD_TYPES) {
      for (const action of CARD_ACTIONS[from]) {
        const targets = allowedTargets(action.creates, action.rel);
        assert.ok(
          targets !== null,
          `${from} 的「${action.label}」：${action.creates} 不能用 ${action.rel}`,
        );
        assert.ok(
          targets?.includes(from),
          `${from} 的「${action.label}」：${action.creates} 的 ${action.rel} 不能指向 ${from}`,
        );
      }
    }
  });

  test('碎片沒有任何 rel，所以也不會有人從它連出去', () => {
    assert.deepEqual(REL_MATRIX.fleeting, [], 'R2：碎片不得有任何連結');
    // 但別人可以連向它——完整化與反駁都是這樣運作的。
    assert.ok(allowedTargets('thinking', 'updates')?.includes('fleeting'));
    assert.ok(allowedTargets('thinking', 'refutes')?.includes('fleeting'));
    assert.ok(!allowedTargets('thinking', 'supports')?.includes('fleeting'),
      'supports 排除碎片：隨口的一句話不能拿來當依據');
  });

  test('矩陣裡的每一條 rel 都在詞彙表內', () => {
    for (const from of CARD_TYPES) {
      for (const spec of REL_MATRIX[from]) {
        assert.ok(REL_TYPES.includes(spec.rel), `${spec.rel} 不在詞彙表內`);
      }
    }
  });
});

describe('工作狀態的四份清單', () => {
  test('待思考：沒有人指向的 original，被指向就離開', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: '還沒人碰過', body: 'x' });
    const b = await createCard(h, { type: 'original', title: '已經被重述過', body: 'y' });
    await createCard(h, {
      type: 'restatement',
      title: '重述 b',
      body: 'z',
      links: [{ rel: 'about', to: b }],
    });

    const page = main(await h.app.fastify.inject('/pending'));
    assert.ok(page.includes('還沒人碰過'));
    assert.ok(!page.includes('已經被重述過'), '被接住的就不是待辦了');
    assert.ok(page.includes(`/c/${a}`));
  });

  test('待思考不區分母卡與節錄：節錄一段，整篇就離開清單', async () => {
    const h = await fresh();
    const whole = await createCard(h, { type: 'original', title: '整篇文章', body: 'x' });
    await createCard(h, {
      type: 'original',
      title: '那幾段',
      body: 'y',
      links: [{ rel: 'part-of', to: whole }],
    });

    const page = main(await h.app.fastify.inject('/pending'));
    assert.ok(!page.includes('整篇文章'), '切開它代表讀過並挑出了值得的部分');
    assert.ok(page.includes('那幾段'), '待辦責任落到那幾段上');
  });

  test('碎片：沒被撿起來用過的 fleeting', async () => {
    const h = await fresh();
    await createCard(h, { type: 'fleeting', title: '一句還沒用過的話' });
    const used = await createCard(h, { type: 'fleeting', title: '已經被完整化的話' });
    await createCard(h, {
      type: 'thinking',
      title: '完整化的結果',
      body: 'x',
      links: [{ rel: 'updates', to: used }],
    });

    const page = main(await h.app.fastify.inject('/fleeting'));
    assert.ok(page.includes('一句還沒用過的話'));
    assert.ok(!page.includes('已經被完整化的話'));
  });

  test('初步想法：進出皆空的 thinking，出向有連結就不算', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    await createCard(h, { type: 'thinking', title: '兩頭都懸空', body: 'y' });
    await createCard(h, {
      type: 'thinking',
      title: '至少接住了原文',
      body: 'z',
      links: [{ rel: 'about', to: o }],
    });

    const page = main(await h.app.fastify.inject('/loose'));
    assert.ok(page.includes('兩頭都懸空'));
    assert.ok(!page.includes('至少接住了原文'), '它自己接住了東西，不算懸空');
  });

  test('沉澱：還改得動的卡片', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '剛寫的還改得動', body: 'x' });
    const page = main(await h.app.fastify.inject('/settling'));
    assert.ok(page.includes('剛寫的還改得動'));
  });

  test('四份清單在每一頁的側欄都在', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: '一篇沒人接的文章', body: 'x' });

    for (const url of ['/', '/tags', '/pending']) {
      const body = (await h.app.fastify.inject(url)).body;
      const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
      // U8：側欄那項叫「雜筆」——它是「fleeting 且無入向連結」，
      // 跟首頁篩選列的「碎片」（全部 fleeting）不是同一個集合。
      for (const name of ['待思考', '初步想法', '雜筆', '沉澱']) {
        assert.ok(aside.includes(name), `${url} 的側欄缺少「${name}」`);
      }
      // U9：不掛數量。那些清單實務上不會歸零，數字提供不了訊號。
      assert.ok(!aside.includes('wcount'), '側欄不該再有數量');
    }
  });
});

describe('每一型的列表項', () => {
  test('original 顯示作者與年份加引用計數，不顯示內文開頭', async () => {
    const h = await fresh();
    const o = await createCard(h, {
      type: 'original',
      title: '近可分解系統',
      body: '我的世界觀是這樣開頭的，這一段不該出現在列表上。',
      source_author: 'Herbert A. Simon',
      source_date: '1962',
    });
    await createCard(h, {
      type: 'restatement',
      title: '重述',
      body: 'x',
      links: [{ rel: 'about', to: o }],
    });
    await createCard(h, {
      type: 'thinking',
      title: '引用它',
      body: 'y',
      links: [{ rel: 'supports', to: o }],
    });

    const body = (await h.app.fastify.inject('/')).body;
    // U5：型別名固定在 meta 行第一段，其餘以 · 分隔。
    assert.ok(body.includes('Herbert A. Simon · 1962'));
    assert.ok(body.includes('1 則重述 / 1 則引用'));
    assert.ok(!body.includes('我的世界觀'), '資料的列表項不顯示內文開頭');
    // U1：型別以左側色點標示，並且一律附上無色的型別名。
    assert.ok(body.includes('dot dot-original'));
    assert.ok(body.includes('class="tname">資料<'));
  });

  test('U5：作者或年份缺漏，整段略過不留空欄', async () => {
    const h = await fresh();
    await createCard(h, {
      type: 'original',
      title: '只有作者',
      body: 'x',
      source_author: 'Simon',
    });
    await createCard(h, { type: 'original', title: '什麼都沒有', body: 'x' });

    const body = (await h.app.fastify.inject('/')).body;
    const rows = body.slice(body.indexOf('class="rows"'));
    // 只有作者也算一段（規格說的是「作者或年份缺漏整段略過」，
    // 指的是整個 source 段落沒東西時不留空欄）。
    assert.ok(rows.includes('Simon'));
    // 什麼都沒有的那張，meta 行只剩型別名。
    assert.ok(!rows.includes('undefined') && !rows.includes('null'));
  });

  test('restatement 顯示它在講哪份原始資料', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '母文件的標題', body: 'x' });
    await createCard(h, {
      type: 'restatement',
      title: '一則重述',
      body: '重述的內文。',
      links: [{ rel: 'about', to: o }],
    });
    const body = (await h.app.fastify.inject('/')).body;
    assert.ok(body.includes('母文件的標題'), 'meta 行要說它在講哪一份');
    assert.ok(body.includes('重述的內文'), '重述要顯示內文開頭');
  });

  test('thinking 只有標題與內文，沒有連結數', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const t = await createCard(h, {
      type: 'thinking',
      title: '有依據的想法',
      body: '想法的內文。',
      links: [{ rel: 'about', to: o }],
    });
    await createCard(h, {
      type: 'thinking',
      title: '接住它',
      body: 'z',
      links: [{ rel: 'supports', to: t }],
    });
    const body = (await h.app.fastify.inject('/')).body;
    assert.ok(body.includes('想法的內文'));
    // 連結數在列表上不驅動任何決定，而它正是讓每一列看起來都一樣的東西。
    assert.ok(!body.includes('↑'), '列表上不再有連結數');
  });

  test('fleeting 的 meta 行只有型別名，標題即全部內容', async () => {
    const h = await fresh();
    await createCard(h, { type: 'fleeting', title: '隨口的一句話' });
    const body = (await h.app.fastify.inject('/')).body;
    const rows = body.slice(body.indexOf('class="rows"'));
    assert.ok(rows.includes('隨口的一句話'));
    assert.ok(rows.includes('class="tname">碎片<'));
    assert.ok(!rows.includes('class="rowtext"'), '標題即全部內容，沒有摘要行');
    // U6：碎片用空心環，是唯一的形狀例外。
    assert.ok(rows.includes('dot dot-fleeting'));
  });

  test('U1：色點負責一眼分辨，型別名負責記得住', async () => {
    const h = await fresh();
    await createCard(h, { type: 'original', title: 'x', body: 'y' });
    const body = (await h.app.fastify.inject('/')).body;
    const rows = body.slice(body.indexOf('class="rows"'));
    // 色點帶型別，文字不上色——顏色本身不可記憶，不得單獨承擔型別資訊。
    assert.ok(rows.includes('class="dot dot-original"'));
    assert.ok(rows.includes('class="tname">資料<'));
    assert.ok(!rows.includes('rtype'), '彩色外框徽章全部移除');
    assert.ok(!rows.includes('>original<'), '列表上不該出現內部型別名');
  });
});

describe('頁面與端點', () => {
  test('建立表單有四個類型、以中文標籤呈現，來源標記維持收合', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject('/new');
    assert.equal(res.statusCode, 200);
    for (const t of ['original', 'restatement', 'thinking', 'fleeting']) {
      assert.ok(res.body.includes(`value="${t}"`), `缺少類型 ${t}`);
    }
    for (const label of ['資料', '重述', '思考', '碎片']) {
      assert.ok(res.body.includes(`<span>${label}</span>`), `缺少型別標籤 ${label}`);
    }
    assert.ok(res.body.includes('<details'), 'provenance 維持收合');
    assert.ok(res.body.includes('/static/js/typefields.js'));
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
        tags: '甲 乙 丙',
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

  test('標籤只用空白分隔，逗號會被擋下來', async () => {
    // 兩種分隔符並存時，`世界觀, 構想` 與 `世界觀 構想` 長得不一樣卻是同一件事，
    // 掃過去分不出標籤的邊界。只留空白之後，看到幾個空白就是幾個標籤。
    //
    // 代價是習慣性打的逗號會黏在標籤上，而卡片過了反芻期就改不動——
    // 所以那不是靜默吞下去，是一條會報錯的規則。
    const h = await fresh();
    const res = await postCard(h, { type: 'thinking', title: '甲', body: 'x', tags: '乙, 丙' });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { errors: string[] }).errors.join(), /不要用逗號/);

    // 全形逗號才是中文輸入法實際會打出來的那個，一樣要擋。
    const full = await postCard(h, { type: 'thinking', title: '甲2', body: 'x', tags: '乙，丙' });
    assert.equal(full.statusCode, 400);

    // 全形空白是空白（JS 的 \s 吃 U+3000），所以它切得開，不是錯誤。
    const ok = await postCard(h, { type: 'thinking', title: '乙', body: 'x', tags: '丁　戊' });
    assert.equal(ok.statusCode, 302);
    const page = await h.app.fastify.inject(ok.headers.location as string);
    for (const t of ['丁', '戊']) assert.ok(page.body.includes(`>#${t}</a>`), `${t} 沒切出來`);

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

  test('靜態檔案掛得起來，而且永遠不會拿到舊版', async () => {
    const h = await fresh();
    const css = await h.app.fastify.inject('/static/css/base.css');
    assert.equal(css.statusCode, 200);
    const js = await h.app.fastify.inject('/static/js/links.js');
    assert.equal(js.statusCode, 200);

    // 改了 CSS 卻看到舊版面，是很難聯想到快取的症狀。
    // no-cache 逼每一層都回來驗證，沒變就 304。
    assert.equal(css.headers['cache-control'], 'no-cache');
    assert.equal(js.headers['cache-control'], 'no-cache');
  });

  test('分頁一頁 50 筆', async () => {
    const h = await fresh();
    for (let i = 0; i < 55; i += 1) {
      await createCard(h, { type: 'thinking', title: `第 ${i} 張`, body: 'x' });
    }
    const p1 = await h.app.fastify.inject('/');
    const p2 = await h.app.fastify.inject('/?page=2');
    const count = (s: string) => (s.match(/<li class="row/g) ?? []).length;
    assert.equal(count(p1.body), 50);
    assert.equal(count(p2.body), 5);

    // 分頁列：用不到的那幾顆不畫，一顆按不動的按鈕是雜訊不是資訊。
    const nav = (s: string) =>
      s.slice(s.indexOf('class="pager"'), s.indexOf('</nav>', s.indexOf('class="pager"')));
    const first = nav(p1.body);
    assert.ok(!first.includes('最新') && !first.includes('上一頁'), '第一頁沒有往回的');
    assert.ok(first.includes('下一頁') && first.includes('最早'), '第一頁要能往後、也能跳到最早');

    const last = nav(p2.body);
    assert.ok(last.includes('最新') && last.includes('上一頁'), '最後一頁要能往回');
    assert.ok(!last.includes('下一頁') && !last.includes('最早'), '最後一頁沒有往後的');
    assert.match(last, /page=1"[^>]*>最新/, '「最新」指第一頁');
    // 箭頭沒有文字，方向要自己說——版面上「左邊比較新」那個線索讀不到。
    assert.match(last, /aria-label="上一頁"/);

    const css = readCss();
    // 形式跟返回／編輯／展開同一套，但**尺寸由分頁列給**：
    // 一行字的高度是滑鼠才點得準的大小。
    assert.match(css, /\.pager \.textbtn\s*\{[^}]*min-height:\s*var\(--tap\)/);
    // 置中：「下一頁」貼在右緣就會被右下角那顆 + 蓋住（手機上尤其明顯）。
    assert.match(css, /\.pager\s*\{[^}]*justify-content:\s*center/);
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

    for (const url of ['/', '/tags', '/pending', '/loose', '/fleeting', '/settling', `/c/${id}`]) {
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

  test('時間軸右下是隨手記，兩個欄位加一顆送出鍵', async () => {
    const h = await fresh();
    const res = await h.app.fastify.inject('/');
    assert.ok(res.body.includes('action="/quick"'), '右下應該是隨手記');
    assert.ok(res.body.includes('name="title"') && res.body.includes('name="body"'));
    // 沒有型別選單、沒有標籤、沒有連結——那是這條路徑存在的理由。
    const quick = res.body.slice(res.body.indexOf('class="quick"'));
    assert.ok(!quick.includes('name="type"'), '隨手記不該有型別選擇');
    assert.ok(!quick.includes('name="tags"'), '隨手記不該有標籤');
    assert.ok(!quick.includes('name="link_rel"'), '隨手記不該有連結');
  });

  test('隨手記可以展開成完整表單，已經打的字跟著過去', async () => {
    // 寫著寫著發現不是一句話講得完的。走 POST 送同一張表單而不是帶 query 的
    // 連結——寫到一半的內容不該出現在網址列、瀏覽器歷史與伺服器日誌裡。
    const h = await fresh();
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/quick',
      payload: new URLSearchParams({
        body: '這件事牽涉到三個層面',
        title: '一個暫定的名字',
        expand: '1',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(h.app.index.countCards(), 0, '展開不是建立，不該留下任何東西');
    assert.ok(res.body.includes('這件事牽涉到三個層面'), '內文要跟著過去');
    assert.ok(res.body.includes('一個暫定的名字'), '標題也要');

    // 隨手記展開僅適用 thinking 型別，故鎖定型別，不顯示型別選單。
    assert.ok(res.body.includes('typefixed'), '型別鎖定，不給選');
    assert.match(res.body, /name="type" value="thinking"/, '鎖定的是 thinking');
    assert.ok(!res.body.includes('class="typepick"'), '不該有型別選單');
    assert.match(
      res.body,
      /<p class="back"><a class="textbtn" href="\/">← 返回<\/a><\/p>/,
      '展開成思考頁面要有返回按鈕',
    );

    // 沒有 expand 的那條路照舊：真的建一張卡。
    const made = await h.app.fastify.inject({
      method: 'POST',
      url: '/quick',
      payload: new URLSearchParams({ body: '一句話', title: '' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(made.statusCode, 302);
    assert.equal(h.app.index.countCards(), 1);
  });

  test('隨手記：不填標題就是碎片，填了就是思考', async () => {
    const h = await fresh();
    const post = async (payload: Record<string, string>) => {
      const res = await h.app.fastify.inject({
        method: 'POST',
        url: '/quick',
        payload,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
      assert.equal(res.statusCode, 302);
      return (res.json() as { id: string }).id;
    };

    const bare = await post({ title: '', body: '一句隨口的話。' });
    const named = await post({ title: '一個主張', body: '主張的內容。' });

    const asFleeting = readCard(h.corpus, bare);
    assert.equal(asFleeting.type, 'fleeting');
    assert.equal(fleetingText(asFleeting), '一句隨口的話。');
    assert.equal(asFleeting.body, '', '碎片的整段文字存在 title，body 留空');

    const asThinking = readCard(h.corpus, named);
    assert.equal(asThinking.type, 'thinking');
    assert.equal(asThinking.title, '一個主張');
    // 卡片檔案一律以換行結尾，所以讀回來的內文帶著它。
    assert.equal(asThinking.body, '主張的內容。\n');
  });

  test('側欄的「追加外部資料」直接開 original 的表單', async () => {
    const h = await fresh();
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
    assert.ok(aside.includes('追加外部資料'));
    assert.ok(aside.includes('/new?type=original'));

    // original 的表單：url 是主要欄位，不藏在收合區裡。
    const form = (await h.app.fastify.inject('/new?type=original')).body;
    const beforeDetails = form.slice(0, form.indexOf('<details'));
    assert.ok(beforeDetails.includes('name="url"'), 'url 應該在收合區之前');
    assert.ok(beforeDetails.includes('name="source_author"'));
    assert.ok(beforeDetails.includes('name="source_date"'));
  });

  test('卡片頁的 + 選單依型別給按鈕，每顆都預填型別與關係', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '被回應的原文', body: 'x' });

    // 屬性裡的 & 會被跳脫成 &amp;，比對前還原回來。
    const card = (await h.app.fastify.inject(`/c/${id}`)).body.replaceAll('&amp;', '&');
    for (const label of ['節錄', '重新描述', '發想', '更新']) {
      assert.ok(card.includes(`<span>${label}</span>`), `選單缺少「${label}」`);
    }
    assert.ok(!card.includes('fabmenu-item rel-'), '選單不再用關係色');
    assert.ok(card.includes('icon-part-of'), '關係改由圖示表達');
    assert.ok(card.includes(`/new?type=original&rel=part-of&to=${id}`), '節錄要預填 part-of');
    assert.ok(card.includes(`/new?type=restatement&rel=about&to=${id}`), '重新描述要滿足 R1');
    assert.ok(!card.includes('牴觸'), 'original 沒有牴觸');

    const form = await h.app.fastify.inject(`/new?type=thinking&rel=about&to=${id}`);
    assert.ok(form.body.includes(`value="${id}"`), '連結目標應預先填好');
    assert.ok(form.body.includes('被回應的原文'), '應顯示目標卡片的標題');
    // 型別由入口決定，鎖住不給改——改了它，預填的關係就不再合法。
    assert.ok(form.body.includes('<input type="hidden" name="type" value="thinking">'));
    assert.ok(form.body.includes('class="typefixed"'));
    assert.ok(!form.body.includes('class="typepick"'), '不該還有型別選擇器');
    assert.ok(
      form.body.includes('<option value="about" selected>'),
      '關係也應預先填好',
    );
    // U16：從卡片 + 預填的那條是唯讀列——只有 rel 可改，目標顯示標題，沒有減號。
    const row = form.body.slice(form.body.indexOf('class="linkrow fixed"'));
    const rowEnd = row.slice(0, row.indexOf('</div>'));
    assert.ok(!rowEnd.includes('rmlink'), '預填的連結不該能刪');
    assert.ok(rowEnd.includes('linktarget'), 'U15：目標顯示標題，ID 不外露');
  });

  test('碎片的 + 選單有完整化，而且把那句話帶進新卡的內文', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'fleeting', title: '一句隨口的話。' });
    const card = (await h.app.fastify.inject(`/c/${id}`)).body.replaceAll('&amp;', '&');

    assert.ok(card.includes('<span>完整化</span>'));
    assert.ok(!card.includes('<span>進一步論述</span>'), 'supports 排除碎片');
    // 選單的順序由 CARD_ACTIONS 排定，碎片最預期的動作（完整化）排第一。
    const menu = card.slice(card.indexOf('class="fabmenu"'));
    assert.ok(menu.indexOf('完整化') < menu.indexOf('反駁'));
    assert.ok(!menu.includes('fabsep'), '分隔線已廢除');
    assert.ok(card.includes(`/new?type=thinking&rel=updates&to=${id}`));

    const form = (await h.app.fastify.inject(`/new?type=thinking&rel=updates&to=${id}`)).body;
    assert.ok(form.includes('一句隨口的話。'), '那段文字要填進新卡的內文');
  });

  test('從外部資料節錄時，自動補上網址、作者、原始年份、標籤、來源標記', async () => {
    const h = await fresh();
    const id = await createCard(h, {
      type: 'original',
      title: '原始長文文獻',
      body: '第一段內容。\n\n第二段內容。',
      url: 'https://example.com/essay',
      source_author: '作者名',
      source_date: '1984',
      tags: ['哲學', '科學'],
      provenance: 'translated',
    });

    const form = (await h.app.fastify.inject(`/new?type=original&rel=part-of&to=${id}`)).body;
    assert.ok(form.includes('value="https://example.com/essay"'), '應自動補上網址');
    assert.ok(form.includes('value="作者名"'), '應自動補上作者');
    assert.ok(form.includes('value="1984"'), '應自動補上原始年份');
    assert.ok(form.includes('value="哲學 科學"'), '應自動補上標籤');
    assert.match(form, /<option value="translated" selected>/, '應自動補上來源標記');
  });

  test('矩陣不允許的組合退回沒有預填連結的表單，而不是給一張送不出去的表', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    // thinking refutes original 不在矩陣裡。
    const form = await h.app.fastify.inject(`/new?type=thinking&rel=refutes&to=${id}`);
    assert.equal(form.statusCode, 200);
    assert.ok(!form.body.includes('linkrow rel-refutes'));
  });

  test('送出後導向新卡片頁，頂端讓來源可一鍵返回', async () => {
    const h = await fresh();
    const source = await createCard(h, { type: 'original', title: '來源那張卡', body: 'x' });
    const res = await h.app.fastify.inject({
      method: 'POST',
      url: '/new',
      payload: {
        type: 'thinking',
        title: '從它發想的',
        body: 'y',
        reply_to: source,
        link_rel: 'about',
        link_to: source,
      },
    });
    assert.equal(res.statusCode, 302);
    const location = res.headers.location as string;
    assert.ok(location.endsWith(`?from=${source}`), `導向應帶著來源，實得 ${location}`);

    const page = (await h.app.fastify.inject(location)).body;
    assert.ok(page.includes('已從'), '頂端要說它是從哪裡建立的');
    assert.ok(page.includes('來源那張卡'));
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
        { rel: 'about', to: a },
        { rel: 'supports', to: b },
      ],
    });

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    const cited = page.slice(page.indexOf('class="stream down"'));

    assert.ok(cited.includes('B 重述 A'), '直接引用要在');
    assert.ok(cited.includes('C 同時引用 A 與 B'), '間接引用也要在');
    assert.ok(cited.includes('關聯出'), '下游用「出」那一套說法');
    assert.ok(cited.includes('支撐出'));
    // U13：列首依 U1 置色點，型別名連寫在標題前。
    assert.ok(cited.includes('dot dot-restatement'));
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
    // U12：關聯區塊在內文之後，所以上游那一疊要從 .links 裡面找。
    const refs = page.slice(page.indexOf('class="stream up"'), page.indexOf('youarehere'));
    assert.ok(refs.includes('B 重述 A'));
    assert.ok(refs.includes('A 原文'), '依賴鏈要能一路追到底');
  });
});

describe('記完之後去哪裡、看到什麼', () => {
  test('碎片記完回首頁，思考跳到新卡片頁', async () => {
    const h = await fresh();
    const quick = async (title: string) => {
      const res = await h.app.fastify.inject({
        method: 'POST',
        url: '/quick',
        payload: { title, body: '內容。' },
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
      return res.headers.location as string;
    };
    // 碎片的標題就是它的全部內容，跳過去只是把同一句話再讀一次。
    assert.equal(await quick(''), '/');
    assert.match(await quick('一個主張'), /^\/c\/[0-9]+$/);
  });

  test('卡片頁只有時間戳記，倒數留在編輯頁', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '剛寫的', body: 'x' });

    const card = (await h.app.fastify.inject(`/c/${id}`)).body;
    assert.ok(!card.includes('id="lock"'), '卡片頁是拿來讀的，不該有每秒跳一次的東西');
    // U4：datetime 是 UTC 真值，內容是伺服器算的保底文字，用戶端再依自己的時區改寫。
    assert.match(card, /<time datetime="[^"]+Z"[^>]*>\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>/);

    const edit = (await h.app.fastify.inject(`/c/${id}/edit`)).body;
    assert.ok(edit.includes('id="lock"'), '編輯頁在跟時間賽跑，倒數留著');
  });

  test('編輯頁的欄位名是中文', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '一', body: 'x' });
    const edit = (await h.app.fastify.inject(`/c/${id}/edit`)).body;
    for (const label of ['標題', '內文', '標籤', '儲存']) {
      assert.ok(edit.includes(label), `編輯頁缺少「${label}」`);
    }
    assert.ok(!edit.includes('>context<'), '不該再有英文欄位名');
  });

  test('清單頁只有標題與筆數，說明只在空的時候出現', async () => {
    const h = await fresh();
    const empty = main(await h.app.fastify.inject('/pending'));
    assert.ok(empty.includes('沒有任何原始資料是無人指向的'), '空的時候要說剛才問了什麼');

    await createCard(h, { type: 'original', title: '一篇文章', body: 'x' });
    const filled = main(await h.app.fastify.inject('/pending'));
    assert.ok(filled.includes('一篇文章'));
    assert.ok(!filled.includes('沒有任何原始資料'), '有東西的時候，東西本身就是說明');
  });

  test('首頁的型別篩選用中文', async () => {
    const h = await fresh();
    const body = (await h.app.fastify.inject('/')).body;
    const at = body.indexOf('class="filters"');
    const filters = body.slice(at, body.indexOf('</div>', at));
    for (const label of ['資料', '重述', '思考', '碎片']) {
      assert.ok(filters.includes(label), `篩選列缺少「${label}」`);
    }
    assert.ok(!filters.includes('original<'), '不該印內部型別名');
    // U7：篩選列各項前方也放同一顆色點——這是學會色彩對應的唯一場所。
    assert.ok(filters.includes('dot dot-original'));
  });
});

describe('連結欄的關係選項', () => {
  const js = fs.readFileSync(path.join('public', 'js', 'links.js'), 'utf8');
  // 「這張卡是什麼型別」由 typefields.js 決定並寫進 data-card-type，
  // links.js 只是看著那個屬性。所以讀型別的規矩要去那一支檢查。
  const typefields = fs.readFileSync(path.join('public', 'js', 'typefields.js'), 'utf8');

  /** 連結列裡那個 select 的選項，依 value 取出來。 */
  const rowOptions = (html: string): string[] => {
    const at = html.indexOf('<div class="linkrow');
    const row = html.slice(at, html.indexOf('</select>', at));
    return [...row.matchAll(/<option value="([a-z-]+)"/g)].map((m) => m[1] as string);
  };

  test('選項依「新卡的型別」與「目標的型別」收窄兩次', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const f = await createCard(h, { type: 'fleeting', title: '一句話' });

    // thinking → original：能 about / supports / related，不能推翻或取代一份材料
    const toOriginal = (await h.app.fastify.inject(`/new?type=thinking&rel=about&to=${o}`)).body;
    assert.deepEqual(rowOptions(toOriginal).sort(), ['about', 'related', 'supports']);

    // thinking → fleeting：能 refutes / updates / related，不能拿碎片當依據
    const toFleeting = (await h.app.fastify.inject(`/new?type=thinking&rel=updates&to=${f}`)).body;
    assert.deepEqual(rowOptions(toFleeting).sort(), ['refutes', 'related', 'updates'].sort());

    assert.ok(!toOriginal.includes('<option value="part-of"'), 'thinking 不能用 part-of');
  });

  test('選項印中文名，不印內部 rel 名也不印說明', async () => {
    const h = await fresh();
    const o = await createCard(h, { type: 'original', title: '原文', body: 'x' });
    const form = (await h.app.fastify.inject(`/new?type=thinking&rel=about&to=${o}`)).body;
    const at = form.indexOf('<div class="linkrow');
    const row = form.slice(at, form.indexOf('</select>', at));

    assert.ok(row.includes('>關聯自<') && row.includes('>支撐自<') && row.includes('>延伸自<'));
    assert.ok(!row.includes('｜'), '不再有「rel｜說明」那種兩段式');
    assert.ok(!row.includes('>about<'), '介面上不出現內部 rel 名');
  });

  test('換參照對象時，前端要把關係重算成合法的', () => {
    // 目標的型別決定了一半的規則，所以選了新目標就得重畫那一列；
    // 原本選的關係若不再合法，落回第一個仍然合法的。
    assert.match(js, /dataset\.targetType = r\.type/, '選了目標要記下它的型別');
    assert.match(js, /paintRow\(input\.closest\('\.linkrow'\)\)/, '記完要重畫那一列');
    assert.match(js, /o\.targets\.indexOf\(targetType\)/, '要依目標型別過濾');
  });

  test('前端讀型別要用 form.elements，不能只認被選中的 radio', () => {
    // 型別由入口決定時是一個 hidden input，':checked' 選不到它——
    // 於是 currentType() 回空字串，關係選項被清空、url 與作者欄被關掉。
    assert.match(typefields, /form\.elements\.type/, '應該用 form.elements 讀型別');
    assert.ok(
      !/querySelector\('input\[name=type\]:checked'\)/.test(typefields),
      "還留著 ':checked' 的寫法，鎖住型別時會整個瞎掉",
    );
  });

  test('還沒選型別時不給空的下拉選單，而是說一句為什麼', async () => {
    const h = await fresh();
    const form = (await h.app.fastify.inject('/new')).body;
    assert.ok(form.includes('id="linkshint"'), '要說明為什麼還不能加連結');
    assert.ok(form.includes('id="linksfield" '.trim()));
    // 連結欄關著：伺服器與前端的退回值要一致，否則載入後畫面會自己跳一下。
    const at = form.indexOf('id="linksfield"');
    assert.ok(form.slice(at - 40, at).includes(' off'), '沒選型別時連結欄應該關著');
    assert.match(typefields, /links: false \};/, '前端的退回值要跟 formSpec() 一致');
  });
});

describe('關係怎麼讀', () => {
  test('同一條連結，兩端兩種說法，關係詞都在標題前面', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    // B --about--> A。在 B 上，A 是上游：「關聯自 A」
    const onB = (await h.app.fastify.inject(`/c/${b}`)).body;
    const up = onB.slice(onB.indexOf('class="stream up"'), onB.indexOf('youarehere'));
    assert.ok(up.includes('關聯自'), '上游用「自」那一套說法');
    assert.ok(!up.includes('關聯出'));
    assert.ok(
      up.indexOf('關聯自') < up.indexOf('A 原文'),
      '關係詞要在標題前面',
    );

    // 在 A 上，B 是下游：「關聯出 B」
    const onA = (await h.app.fastify.inject(`/c/${a}`)).body;
    const down = onA.slice(onA.indexOf('class="stream down"'));
    assert.ok(down.includes('關聯出'), '下游用「出」那一套說法');
    assert.ok(!down.includes('關聯自'));
    assert.ok(down.indexOf('關聯出') < down.indexOf('B 重述 A'));
  });

  test('反駁的方向不能含糊：一邊反駁，另一邊被反駁', async () => {
    const h = await fresh();
    const t = await createCard(h, { type: 'thinking', title: '被推翻的主張', body: 'x' });
    const r = await createCard(h, {
      type: 'thinking',
      title: '推翻它的那張',
      body: 'y',
      links: [{ rel: 'refutes', to: t }],
    });

    const onR = (await h.app.fastify.inject(`/c/${r}`)).body;
    const up = onR.slice(onR.indexOf('class="stream up"'), onR.indexOf('youarehere'));
    assert.ok(up.includes('反駁') && !up.includes('被反駁'), '這張是反駁方');

    const onT = (await h.app.fastify.inject(`/c/${t}`)).body;
    const down = onT.slice(onT.indexOf('class="stream down"'));
    assert.ok(down.includes('被反駁'), '這張是被反駁方');
  });

  test('上游那一疊跟下游鏡像對稱', async () => {
    // 下游的規矩：離卡片越近的越靠近卡片、同層第一個排最前。
    // 上游要把這些整個翻過來——缺一件就會露出破綻。
    //
    // 這件事先前是三條 column-reverse 加一條 details 的補丁做的；引用串攤平
    // 之後改由伺服器直接輸出反序，所以這裡盯的是**輸出的順序**，
    // CSS 只剩軌道要跟著鏡射。
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

    // 下游：離卡片近的（B）在上，遠的（C）在下。
    const onA = (await h.app.fastify.inject(`/c/${a}`)).body;
    const down = onA.slice(onA.indexOf('class="stream down"'));
    assert.ok(down.indexOf('B 重述 A') < down.indexOf('C 引用 B'), '下游由近而遠往下長');

    // 上游：整個翻過來，離卡片近的（B）在下，遠的（A）在上。
    const onC = (await h.app.fastify.inject(`/c/${c}`)).body;
    const up = onC.slice(onC.indexOf('class="stream up"'), onC.indexOf('youarehere'));
    assert.ok(up.indexOf('A 原文') < up.indexOf('B 重述 A'), '上游由遠而近往下長');

    // 軌道跟著鏡射一次，轉角才會翻到正確的一側。
    const css = readCss();
    assert.match(css, /\.stream\.up \.rails\s*\{[^}]*scaleY\(-1\)/);
    // 翻轉容器那一套已經拆掉了，不該再有人靠 column-reverse 排引用串。
    assert.ok(!/\.stream\.up[^{]*\{[^}]*column-reverse/.test(css), '容器不再翻轉');
    assert.ok(!css.includes('.node details'), '收合不再靠 <details>');
  });

  test('需要 JS 才有作用的按鈕，沒有 JS 就不畫', () => {
    // 「沒有 JS 就展不開」是少一個能力；「按鈕在但按了沒反應」是介面在說謊。
    const css = readCss();
    assert.match(css, /html:not\(\.js\)[^{]*\.nodetoggle[^{]*\{[^}]*display:\s*none/);
    assert.match(css, /html:not\(\.js\)[^{]*\.threadtoggleall[^{]*\{[^}]*display:\s*none/);
  });

  test('軌道只在那一層還有兄弟時才畫線', async () => {
    // 攤平之後縮排由每一列自己畫，所以「這是不是最後一個」必須寫進標記裡：
    // 不是最後一個畫 T 形（線繼續往下），是最後一個畫 L 形（線到此為止）。
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });
    for (const t of ['C 支撐 B', 'D 支撐 B']) {
      await createCard(h, {
        type: 'thinking',
        title: t,
        body: 'z',
        links: [{ rel: 'supports', to: b }],
      });
    }

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    const down = page.slice(page.indexOf('class="stream down"'));

    // B 在深度 0，沒有軌道；C 與 D 在深度 1，兩個之中只有一個是最後一個。
    assert.equal(down.split('rail-elbow').length - 1, 1, '只有最後一個收尾');
    assert.equal(down.split('rail-tee').length - 1, 1, '另一個要讓線繼續往下');
  });

  test('牴觸是對稱的，兩端說法相同', () => {
    assert.equal(REL_LABELS.contradicts, REL_LABELS_BACK.contradicts);
    // 其餘六條都要能分辨方向，否則關係會被讀反。
    for (const rel of REL_TYPES) {
      if (rel === 'contradicts') continue;
      assert.notEqual(
        REL_LABELS[rel],
        REL_LABELS_BACK[rel],
        `${rel} 的兩個方向說法不該一樣`,
      );
    }
  });

  test('七個關係都有名字、也都有圖示', async () => {
    const h = await fresh();
    // 每一條 rel 都要畫得出來，否則選單上會有一格是空的。
    const rendered = REL_TYPES.map((rel) => renderIcon(rel));
    for (const [i, svg] of rendered.entries()) {
      assert.ok(svg.includes('<path') || svg.includes('<rect'), `${REL_TYPES[i]} 沒有圖形`);
    }
    for (const rel of REL_TYPES) {
      for (const table of [REL_LABELS, REL_LABELS_BACK]) {
        assert.ok((table[rel] ?? '').length > 0, `${rel} 少一個方向的名字`);
        assert.ok(!/[a-z]/.test(table[rel] ?? ''), `${rel} 的名字不該有英文`);
      }
    }
    assert.ok(h);
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
    assert.ok(page.includes('referrerpolicy="strict-origin-when-cross-origin"'));
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
  test('順序是站名、首頁、工作狀態、動作與工具、最近卡片', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '最近寫的一張', body: 'x' });
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));

    // 側欄依序包含：站名、首頁、工作清單、動作與工具、卡片索引。用只出現一次的記號定位。
    const order = ['drawerbrand', 'icon-home', 'drawernav', 'icon-plus', 'cardindex'];
    let at = -1;
    for (const cls of order) {
      const next = aside.indexOf(cls);
      assert.ok(next > at, `${cls} 的位置不對`);
      at = next;
    }
    assert.ok(aside.includes('最近寫的一張'), '卡片索引要列在側欄');
    assert.ok(!aside.includes('drawernew'), '左下不該再有建立卡片');
  });

  test('站名不可點，第一列是首頁', async () => {
    const h = await fresh();
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
    assert.ok(aside.includes('<p class="drawerbrand">Skynote</p>'), '站名是標題不是連結');
    const top = aside.slice(aside.indexOf('drawerwork'));
    assert.ok(top.slice(0, top.indexOf('</nav>')).includes('首頁'));
  });

  test('U10：追加外部資料與標籤、搜尋同格式', async () => {
    const h = await fresh();
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));

    for (const name of ['home', 'plus', 'tag', 'search']) {
      assert.ok(aside.includes(`icon-${name}`), `側欄缺少 ${name} 圖示`);
    }
    // 動作與工具區項目不使用專屬格式。
    assert.ok(!aside.includes('draweraction'), '不該再有專屬格式');

    // U9：工作狀態那幾項不掛數量。
    const work = aside.slice(aside.indexOf('drawerwork'), aside.indexOf('cardindex'));
    assert.ok(!work.includes('wcount'));
  });

  test('U11：卡片索引有小標，職責在畫面上可讀', async () => {
    const h = await fresh();
    await createCard(h, { type: 'thinking', title: '一張卡', body: 'x' });
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
    // 它的用途是建立連結時查名稱，不是導覽——所以要說出來，不能看起來像第二份清單。
    assert.ok(aside.includes('class="indexhead">卡片索引<'));
    assert.ok(aside.includes('一張卡'));
  });

  test('搜尋是一個連結，不是側欄裡的輸入框', async () => {
    const h = await fresh();
    const body = (await h.app.fastify.inject('/')).body;
    const aside = body.slice(body.indexOf('<aside'), body.indexOf('</aside>'));
    assert.ok(aside.includes('href="/search"'));
    assert.ok(!aside.includes('drawersearch'), '側欄不再有輸入框');

    const page = await h.app.fastify.inject('/search');
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('class="searchpage"'));
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

describe('內文的換行', () => {
  test('單一換行就是換行，不併成一個空格', () => {
    // 刻意偏離 CommonMark。那條規則服務的是「原始碼裡硬斷行、輸出時重新排版」
    // 的寫作方式，而這裡的內文是打在 textarea 裡的——沒有人在文字框裡把散文
    // 斷在第 80 個字元。在這個輸入情境下，一個換行就是一次刻意的換行。
    const html = renderMarkdown('第一行\n第二行');
    assert.match(html, /第一行<br>\s*第二行/);
    assert.ok(!html.includes('第一行 第二行'), '不該併成一個空格');
  });

  test('換行不影響區塊的切法，所以引用錨點不會腐爛', () => {
    // #b{n} 指的是第 n 個**頂層區塊**。breaks 只動段落內的軟換行，不動區塊
    // 結構——這一條要有測試，否則哪天把 breaks 關掉就會讓既有的引用連結
    // 整批指錯，而且不會報任何錯。
    const html = renderMarkdown('一\n二\n三\n\n第二段\n也有兩行\n\n- 甲\n- 乙');
    assert.deepEqual(
      [...html.matchAll(/data-b="(\d+)"/g)].map((m) => m[1]),
      ['0', '1', '2'],
      '三個頂層區塊，序號連續',
    );
    assert.equal((html.match(/<br>/g) ?? []).length, 3, '段落內的換行各自成立');
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
    const card = page.indexOf('<article');
    const up = page.indexOf('class="stream up"');
    const here = page.indexOf('youarehere');
    const down = page.indexOf('class="stream down"');

    assert.ok(card > -1 && up > -1 && here > -1 && down > -1, '四塊都要在');
    // U12：卡片內容在前，關聯區塊在後。先前把關聯樹放在標題之上，
    // 一進頁面先讀到後設資料，而且標題的垂直位置隨連結多寡浮動。
    assert.ok(card < up, '內文要在關聯區塊之前');
    // U13：上游在上、下游在下，中間是「你在這裡」——方向由空間位置表達。
    assert.ok(up < here && here < down, '上游、你在這裡、下游');
    assert.ok(page.includes('↑ 1') && page.includes('↓ 1'), '方向用箭頭加數量表示');

    // 計數緊貼「你在這裡」那一側，箭頭才指得對。
    const upBlock = page.slice(up, here);
    assert.ok(
      upBlock.indexOf('class="thread"') < upBlock.indexOf('streamcount'),
      '↑ 應該在上游清單之後',
    );
    const downBlock = page.slice(down);
    assert.ok(
      downBlock.indexOf('streamcount') < downBlock.indexOf('class="thread"'),
      '↓ 應該在下游清單之前',
    );
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

  test('「你在這裡」包含相對時間戳記，有巢狀節點時顯示全部展開按鈕', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'thinking', title: 'A 思考', body: 'x' });
    const b = await createCard(h, {
      type: 'thinking',
      title: 'B 思考',
      body: 'y',
      links: [{ rel: 'supports', to: a }],
    });
    await createCard(h, {
      type: 'thinking',
      title: 'C 思考',
      body: 'z',
      links: [{ rel: 'supports', to: b }],
    });

    // A 頁面：下游是 B，B 又有子節點 C，所以有可展開節點
    const pageA = (await h.app.fastify.inject(`/c/${a}`)).body;
    const hereA = pageA.slice(pageA.indexOf('class="youarehere"'), pageA.indexOf('</p>', pageA.indexOf('class="youarehere"')));
    assert.ok(hereA.includes('你在這裡：<span>A 思考</span>'), '標題在「你在這裡」中');
    assert.ok(hereA.includes('data-rel'), '時間帶 data-rel');
    assert.ok(hereA.includes('nodetime clock num'), '時刻插槽存在');
    assert.ok(hereA.includes('threadtoggleall'), '有巢狀子節點時應顯示全部展開按鈕');
    assert.ok(hereA.includes('全部展開'), '按鈕文字預設為全部展開');

    // 孤立卡片：無連結，只有時間，不顯示全部展開按鈕
    const alone = await createCard(h, { type: 'thinking', title: '孤零零', body: 'x' });
    const pageAlone = (await h.app.fastify.inject(`/c/${alone}`)).body;
    const hereAlone = pageAlone.slice(pageAlone.indexOf('class="youarehere"'), pageAlone.indexOf('</p>', pageAlone.indexOf('class="youarehere"')));
    assert.ok(hereAlone.includes('你在這裡：<span>孤零零</span>'));
    assert.ok(hereAlone.includes('data-rel'));
    assert.ok(!hereAlone.includes('threadtoggleall'), '無可展開節點時不顯示全部展開按鈕');
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
    const at = page.indexOf('class="nodebody"');
    assert.ok(at > -1, '可點區域要自成一塊');

    // 可點區域包住標題與日期，但不包住左邊的軌道——蓋到軌道上會變成
    // 點線也跳頁。所以 .rails 在 .nodebody 外面。
    const row = page.slice(at, page.indexOf('</li>', at));
    assert.ok(row.includes('nodetitle'), '標題在可點區域裡');
    assert.ok(row.includes('<time'), '日期也在可點區域裡');
    assert.ok(page.slice(page.indexOf('<li class="node'), at).includes('rails'), '軌道在外面');

    const css = readCss();
    assert.match(css, /\.nodetitle::after\s*\{[^}]*inset:\s*0/, '整塊靠 ::after 蓋出來');
    // 展開鈕在那層蓋子上面，否則按不到。
    assert.match(css, /\.nodetoggle\s*\{[^}]*z-index/);
  });

  test('引用串一列一行：標題截斷，時刻補在日期後面', async () => {
    // 軌道要連續，列與列之間就不能有間隙，於是每一列必須是固定的一行高。
    // 中文標題沒有長度上限，所以它得截斷——這是攤平換來的節奏的代價。
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    await createCard(h, {
      type: 'thinking',
      title: '一個長到不可能排得下的中文標題'.repeat(4),
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const page = (await h.app.fastify.inject(`/c/${a}`)).body;
    // 時刻緊接在日期後面（app.js 找的是相鄰的那一格）。
    assert.match(page, /<\/time>\s*<span class="nodetime clock/);

    const css = readCss();
    assert.match(css, /\.nodetitle\s*\{[^}]*text-overflow:\s*ellipsis/);
    assert.match(css, /\.node\s*\{[^}]*min-height:\s*var\(--rail-h\)/);
    // 沒有 margin，軌道才接得起來。
    assert.ok(!/\.node\s*\{[^}]*margin/.test(css), '列與列之間不留間距');
  });
});

describe('碎片沒有標題', () => {
  // 碎片的整段話存在 title 欄位裡（domain/card.ts 的欄位反轉），但那是儲存上的
  // 權宜，不是說它真的有一個名字。印成標題就會得到一面粗體的牆。

  test('卡片頁把那段話當內文排，不當標題', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'fleeting', title: '憑空想到的一句話', body: '' });
    const page = (await h.app.fastify.inject(`/c/${id}`)).body;
    const article = page.slice(page.indexOf('<article'), page.indexOf('</article>'));

    assert.ok(!article.includes('<h1'), '碎片不該有標題');
    const body = article.slice(article.indexOf('<div class="body"'));
    assert.ok(body.includes('憑空想到的一句話'), '那段話要在內文的位置');

    // 有標題的型別照舊。
    const t = await createCard(h, { type: 'thinking', title: '有名字的', body: 'x' });
    assert.ok((await h.app.fastify.inject(`/c/${t}`)).body.includes('<h1'));
  });

  test('列表用日期當列首，那段話走內文的位置而且點得進去', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'fleeting', title: '隨手記的一句', body: '' });
    const feed = (await h.app.fastify.inject('/')).body;
    // 側欄的卡片索引也有 <li>，而且排在前面，所以結尾要從列首開始找。
    const rowAt = feed.indexOf('<li class="row untitled">');
    const row = feed.slice(rowAt, feed.indexOf('</li>', rowAt));

    assert.ok(rowAt > -1, '沒有標題的列要標出來，色點才知道自己該對哪一行');
    assert.ok(!row.includes('rowtitle'), '碎片沒有標題那一格');
    // 一則隨手記靠「什麼時候寫的」認，所以列首只剩日期。
    const headAt = row.indexOf('class="rowhead"');
    const head = row.slice(headAt, row.indexOf('</p>', headAt));
    assert.ok(head.includes('<time'), '列首要有日期');
    // 沒有標題的話，內文自己得是連結，否則這一列點不進去。
    assert.match(row, /<a class="rowtext rowbody" href="\/c\/[^"]+">隨手記的一句<\/a>/);

    const css = readCss();
    assert.match(css, /\.rowbody::after\s*\{[^}]*inset:\s*0/);
  });

  test('沒有標題的那一列，色點對的是日期而不是標題', () => {
    // 色點落在「列首那一行」的行框中心。列首是哪一行不是固定的：
    // 有標題的列是 17px 的標題，碎片的列首只剩 13px 的日期。
    // 這條規則先前寫死標題的行框，碎片的點因此落太低。
    const css = readCss();
    assert.match(
      css,
      /\.row > \.dot\s*\{[^}]*margin-top:\s*calc\(\(var\(--head-line\)/,
      '色點的位置要讀 --head-line，不能寫死某一種字級',
    );
    assert.match(css, /\.row\b[^{]*\{[^}]*--head-line:\s*calc\(var\(--fs-3\)/);
    assert.match(css, /\.row\.untitled\s*\{[^}]*--head-line:\s*calc\(var\(--fs-1\)/);
    // 兩種列各有自己的微調旋鈕：校準的不是同一行字，共用必有一邊是歪的。
    assert.match(css, /--dot-nudge-untitled:/);
    assert.match(css, /\.row\.untitled\s*\{[^}]*--dot-shift:\s*var\(--dot-nudge-untitled\)/);
  });

  test('來源面板與完整化都走同一條判斷', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'fleeting', title: '值得再想的一句', body: '' });
    const page = (await h.app.fastify.inject(`/new?to=${id}&type=thinking&rel=updates`)).body;
    const pane = page.slice(page.indexOf('pane-source'), page.indexOf('quotebar'));

    assert.ok(!pane.includes('<h1'), '來源面板也不該把碎片印成標題');
    assert.ok(pane.includes('值得再想的一句'), '那段話要在面板的內文裡');
  });
});

describe('標題沒有長度上限', () => {
  // 任何型別的標題都可能過長，而版面每一處都假設它很短。
  // 分兩種處理：自成一格的位置交給 CSS，嵌進句子裡的位置在伺服器截。

  const LONG = '一個很長的標題'.repeat(12);

  test('卡片頁不截標題，改降一階視覺重量', async () => {
    const h = await fresh();
    const long = await createCard(h, { type: 'thinking', title: LONG, body: 'x' });
    const short = await createCard(h, { type: 'thinking', title: '短的', body: 'x' });

    const pl = (await h.app.fastify.inject(`/c/${long}`)).body;
    // 不截：這是唯一看得到完整標題的地方。
    assert.ok(pl.includes(`<h1 class="long">${LONG}</h1>`), '長標題完整顯示並標記');

    const ps = (await h.app.fastify.inject(`/c/${short}`)).body;
    assert.ok(ps.includes('<h1 class="">短的</h1>'), '短標題不標記');

    const css = readCss();
    assert.match(css, /h1\.long\s*\{[^}]*font-size:\s*var\(--fs-3\)/);
  });

  test('嵌進句子裡的標題在伺服器截', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: LONG, body: 'x', url: '' });

    // 「從《X》的節錄」——X 夾在句子中間，CSS 截不乾淨。
    const form = (await h.app.fastify.inject(`/new?to=${id}&type=restatement&rel=about`)).body;
    const titleAt = form.indexOf('class="formtitle"');
    const title = form.slice(titleAt, form.indexOf('</h1>', titleAt));
    assert.ok(title.includes('…'), '截過');
    assert.ok(!title.includes(LONG), '不該印出完整標題');

    // 「已從 X 建立」同理。
    const other = await createCard(h, { type: 'thinking', title: '另一張', body: 'y' });
    const page = (await h.app.fastify.inject(`/c/${other}?from=${id}`)).body;
    const from = page.slice(page.indexOf('class="fromsource"'), page.indexOf('</p>', page.indexOf('class="fromsource"')));
    assert.ok(from.includes('…') && !from.includes(LONG), '已從 X 建立也要截');
  });

  test('自成一格的位置交給 CSS，不在伺服器猜寬度', async () => {
    const h = await fresh();
    const id = await createCard(h, { type: 'original', title: LONG, body: 'x', url: '' });

    // 列表：完整標題照樣送出去，由 .rowtitle 截兩行。
    const feed = (await h.app.fastify.inject('/')).body;
    assert.ok(feed.includes(LONG), '伺服器不截，能排幾個字是版面決定的');

    // 連結列的目標卡：同理，完整的字留在 title 屬性裡。
    const form = (await h.app.fastify.inject(`/new?to=${id}&type=restatement&rel=about`)).body;
    assert.match(form, /<span class="linktarget" title="[^"]*一個很長的標題/);

    const css = readCss();
    assert.match(css, /\.rowtitle\s*\{[^}]*-webkit-line-clamp:\s*2/);
    assert.match(css, /\.linktarget\s*\{[^}]*text-overflow:\s*ellipsis/);
  });
});

describe('反芻期內的連結（R7、R8）', () => {
  const put = (h: Harness, id: string, payload: Record<string, unknown>) =>
    h.app.fastify.inject({
      method: 'PUT',
      url: `/c/${id}`,
      payload,
      headers: { 'content-type': 'application/json' },
    });

  test('只增不減：請求裡沒有刪除的表示法', async () => {
    // 「只增不減」不是靠比對守住的——patch 裡根本沒有「完整的 links」這個欄位。
    // 收整份再 diff 的話，那條規則會變成一段可能寫錯的程式碼，
    // 而寫錯的樣子是一條連結無聲消失。
    const h = await fresh();
    const t1 = await createCard(h, { type: 'thinking', title: 'T1', body: 'x' });
    const t2 = await createCard(h, {
      type: 'thinking',
      title: 'T2',
      body: 'y',
      links: [{ rel: 'related', to: t1 }],
    });

    // 送一份「只剩零條」的 links 上去：它不是這條路徑認得的欄位，所以什麼都沒發生。
    const res = await put(h, t2, { links: [] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(index0(h, t2), ['related'], '既有的連結一條都不能少');
  });

  test('新增的每一條都要通過當下的現行規則', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const t1 = await createCard(h, { type: 'thinking', title: 'T1', body: 'x' });
    const t2 = await createCard(h, {
      type: 'thinking',
      title: 'T2',
      body: 'y',
      links: [{ rel: 'related', to: t1 }],
    });

    // 合法：既有的留著，新的接在後面。
    assert.equal((await put(h, t2, { add_links: [{ rel: 'about', to: a }] })).statusCode, 200);
    assert.deepEqual(index0(h, t2), ['about', 'related']);

    // R3 的矩陣。
    const matrix = await put(h, t2, { add_links: [{ rel: 'part-of', to: a }] });
    assert.equal(matrix.statusCode, 400);
    assert.match(errorsOf(matrix), /思考不能用 part-of/);

    // 同 rel 同目標不得重複——跟**既有的**比，不只是跟這一批裡的比。
    const dup = await put(h, t2, { add_links: [{ rel: 'related', to: t1 }] });
    assert.equal(dup.statusCode, 400);
    assert.match(errorsOf(dup), /重複/);

    // 目標必須存在。
    const missing = await put(h, t2, { add_links: [{ rel: 'related', to: '11111111111111111' }] });
    assert.match(errorsOf(missing), /目標不存在/);

    // 目標的 ID 必須比自己小：連結一律由新指向舊。
    // 拿一張沒人指向的卡來試——t1 已經被 t2 指著，那會先撞上 R6 而不是順序。
    const solo = await createCard(h, { type: 'thinking', title: '沒人指向它', body: 'z' });
    const newer = await createCard(h, { type: 'thinking', title: '更新的', body: 'z' });
    const order = await put(h, solo, { add_links: [{ rel: 'related', to: newer }] });
    assert.equal(order.statusCode, 400);
    assert.match(errorsOf(order), /目標比這張卡新/);

    // 一路下來，t2 的連結還是那兩條——被擋下來的都沒有留下痕跡。
    assert.deepEqual(index0(h, t2), ['about', 'related']);
  });

  test('R8：碎片不得有連結，編輯頁也不給那個區塊', async () => {
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const f = await createCard(h, { type: 'fleeting', title: '一句話', body: '' });

    const page = (await h.app.fastify.inject(`/c/${f}/edit`)).body;
    assert.ok(!page.includes('id="linksfield"'), '碎片的編輯頁沒有連結欄');

    const res = await put(h, f, { add_links: [{ rel: 'related', to: a }] });
    assert.equal(res.statusCode, 400);
    assert.match(errorsOf(res), /碎片/);
  });

  test('定案之後連結也加不了（R6）', async () => {
    const h = await fresh();
    const t1 = await createCard(h, { type: 'thinking', title: 'T1', body: 'x' });
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'y' });
    // 有人指向 T1，它就定案了——三件事一個判準，新增連結也在那三件裡。
    await createCard(h, {
      type: 'thinking',
      title: 'T2',
      body: 'z',
      links: [{ rel: 'related', to: t1 }],
    });

    const res = await put(h, t1, { add_links: [{ rel: 'about', to: a }] });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(index0(h, t1), []);
  });

  test('編輯頁上，既有的連結是一份唯讀清單，不是表單列', async () => {
    // 兩者長得不一樣是刻意的：「不能刪」因此不必用一句說明去守，
    // 畫面上根本沒有那個入口。
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A 原文', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B 重述 A',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });

    const page = (await h.app.fastify.inject(`/c/${b}/edit`)).body;
    const at = page.indexOf('id="linksfield"');
    assert.ok(at > -1);
    const field = page.slice(at, page.indexOf('fieldnote', at));

    // 既有的那一條在唯讀清單裡，帶著方向正確的關係詞。
    assert.match(field, /<ul class="linklist">/);
    assert.ok(field.includes('關聯自'), '關係詞用出向那一套說法');
    assert.ok(field.includes(`/c/${a}`), '看得到它指向誰');
    // 它不在 #linkrows 裡——那裡只放還沒送出的新列。
    const rows = field.slice(field.indexOf('id="linkrows"'));
    assert.ok(!rows.includes(`/c/${a}`), '既有的連結不會變成可編輯的表單列');

    // 選項只給這張卡的型別用得到的那幾條。
    assert.match(field, /data-card-type="restatement"/);
    assert.ok(field.includes('&quot;restatement&quot;'), 'rel 表以型別為鍵');
  });
});

describe('動作的形式是一份', () => {
  test('四種文字按鈕共用同一份樣式，尺寸由所在的地方決定', async () => {
    // 返回、編輯、展開（▾ n）、全部展開先前各寫一份幾乎相同的樣式，
    // 只有 .actions a 漏掉了內距與 hover——同一種東西在四個地方長得不一樣。
    const h = await fresh();
    const a = await createCard(h, { type: 'original', title: 'A', body: 'x' });
    const b = await createCard(h, {
      type: 'restatement',
      title: 'B',
      body: 'y',
      links: [{ rel: 'about', to: a }],
    });
    const c = await createCard(h, {
      type: 'thinking',
      title: 'C',
      body: 'z',
      links: [{ rel: 'supports', to: b }],
    });

    const card = (await h.app.fastify.inject(`/c/${a}`)).body;
    for (const mark of ['back"><a class="textbtn"', 'textbtn threadtoggleall', 'textbtn nodetoggle']) {
      assert.ok(card.includes(mark), `${mark} 要套同一份`);
    }
    // 編輯鈕只在還改得動的卡片上，所以看沒被指向的那一張（A 已經被 B 指著）。
    assert.match((await h.app.fastify.inject(`/c/${c}`)).body, /class="actions"><a class="textbtn"/);
    assert.ok((await h.app.fastify.inject(`/c/${c}/edit`)).body.includes('back"><a class="textbtn"'));

    const css = readCss();
    // 形式一份就好，但**不設 font-size**：返回是頁面層級的動作（fs-2），
    // 展開住在 13px 的引用串列裡。統一的是形式，不是尺寸——把展開鈕放大到
    // 跟返回一樣，會把引用串的行高撐開。
    const rule = css.slice(css.indexOf('.textbtn {'), css.indexOf('}', css.indexOf('.textbtn {')));
    assert.ok(!rule.includes('font-size'), '.textbtn 不該自己決定尺寸');
    assert.match(css, /\.textbtn:hover\s*\{[^}]*background:\s*var\(--hover-bg\)/);
  });

  test('動作列的規矩：按最多次的靠左，破壞性頂到右端', async () => {
    // 排序依的是移動成本：內容欄靠左對齊，游標平常就在左邊。最便宜的位置
    // 給每次都要按的，最貴的給一輩子按幾次的。一條規矩管所有的動作列，
    // 包括只有一顆送出鈕的建立頁。
    const h = await fresh();
    const id = await createCard(h, { type: 'thinking', title: '還改得動', body: 'x' });

    const edit = (await h.app.fastify.inject(`/c/${id}/edit`)).body;
    const nav = edit.slice(edit.indexOf('class="stepnav"'), edit.indexOf('</div>', edit.indexOf('class="stepnav"')));
    assert.ok(nav.indexOf('儲存') < nav.indexOf('取消'), '儲存排在最前');
    assert.ok(nav.indexOf('取消') < nav.indexOf('deletecard'), '刪除排在最後');

    // 建立頁的送出也在同一種列裡，才會落在同一個位置。
    assert.match((await h.app.fastify.inject('/new')).body, /class="stepnav">\s*<button type="submit"/);

    const css = readCss();
    assert.match(css, /\.stepnav\s*\{[^}]*justify-content:\s*flex-start/);
    // 三顆按鈕在這一列裡是同一個尺寸；尺寸由容器給，所以行內那些 ＋／− 的
    // .ghost 不受影響（跟 .textbtn 同一個做法）。
    assert.match(css, /\.stepnav > \*\s*\{[^}]*font-size:\s*var\(--fs-2\)[^}]*padding:/);
    // 填色只有「儲存」一顆——那是「哪個是預設動作」唯一的訊號。
    const del = css.slice(css.indexOf('.destructive {'), css.indexOf('}', css.indexOf('.destructive {')));
    assert.ok(!del.includes('background: var(--alert)'), '刪除不填色');
    assert.match(del, /color:\s*var\(--alert\)/, '但字是警示色');
    // 刪除頂到另一端：內容欄靠左，所以右端是游標最遠的地方。距離是它現在
    // 唯一的物理保護——先前那條分隔線已經沒有了。
    assert.match(css, /\.stepnav \.destructive\s*\{[^}]*margin-left:\s*auto/);
  });

  test('側欄索引用色點分辨型別，不放型別名', async () => {
    // 那一欄很窄，標題本來就在截斷邊緣，再塞兩個字等於把標題再砍掉兩個字。
    const h = await fresh();
    await createCard(h, { type: 'fleeting', title: '一句話', body: '' });

    const page = (await h.app.fastify.inject('/')).body;
    const at = page.indexOf('cardindex');
    const index = page.slice(at, page.indexOf('</div>', at));

    assert.ok(index.includes('dot dot-fleeting'), '型別靠色點');
    assert.ok(!index.includes('tname'), '不放型別名');
    // 截斷落在標題上，不落在整條連結上——否則色點會跟著被裁掉。
    const css = readCss();
    assert.match(css, /\.indextitle\s*\{[^}]*text-overflow:\s*ellipsis/);
    // 13px 的文字配小一號的色點。改寫容器上的 --dot 就整組跟著縮，
    // 不必多一條 .dot 的規則。
    assert.match(css, /\.cardindex\s*\{[^}]*--dot:\s*var\(--dot-sm\)/);
  });
});

describe('標籤推薦', () => {
  test('既有標籤依用過幾張卡排序，全部列出，兩張表單都有', async () => {
    // 這不是標籤正規化（那是事後合併，spec 明確排除）。它不改任何資料，
    // 只在你打字的當下讓你看見既有的——一個是修正，一個是預防。
    const h = await fresh();
    for (const [t, tags] of [
      ['A', '自我分析 世界觀構想'],
      ['B', '自我分析'],
      ['C', '自我分析 遊戲構想'],
    ] as const) {
      await createCard(h, { type: 'thinking', title: t, body: 'x', tags });
    }
    const id = await createCard(h, { type: 'thinking', title: 'D', body: 'x' });

    for (const url of ['/new?type=thinking', `/c/${id}/edit`]) {
      const page = (await h.app.fastify.inject(url)).body;
      const at = page.indexOf('id="tagsfield"');
      assert.ok(at > -1, `${url} 要有標籤欄`);
      const field = page.slice(at, page.indexOf('</label>', at));
      assert.ok(field.includes('tagpicker'), `${url} 要有推薦面板`);

      const raw = /data-tags='([^']*)'/.exec(field)?.[1] ?? '';
      const list = JSON.parse(raw.replaceAll('&quot;', '"')) as { tag: string; n: number }[];
      // 全部列出來：截斷會把長尾藏起來，而長尾正是「上次到底打哪個字」最需要看見的。
      assert.equal(list.length, 3, `${url} 三個標籤都要在`);
      assert.equal(list[0]?.tag, '自我分析', '用得最多的排最前');
      assert.equal(list[0]?.n, 3);
    }

    // 面板高度有上限、用捲的，而不是只列前幾個。
    const css = readCss();
    assert.match(css, /\.tagpicker\s*\{[^}]*max-height:\s*var\(--picker-max\)/);
    assert.match(css, /\.tagpicker\s*\{[^}]*overflow-y:\s*auto/);
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

describe('樣式的紀律', () => {
  /**
   * U35：token 表是樣式值的唯一真相來源。
   *
   * 這條紀律沒有機制就只是願望——所以這裡真的去掃。元件裡不得寫死顏色、
   * 間距、字級、陰影、動效時間；tokens.css 以外的每一支只能用 var()。
   *
   * 白名單是那些「進 token 反而更難讀」的值：邊框寬、圓形的 50%、
   * 位移補償的 1px、以及百分比與 vh/vw 這類跟版面綁在一起的單位。
   */
  const COMPONENT_FILES = ['base', 'shell', 'list', 'card', 'form'];
  const ALLOWED_PX = new Set(['0px', '1px', '2px']);

  const read = (name: string) =>
    fs.readFileSync(path.join('public', 'css', `${name}.css`), 'utf8');

  /** 去掉註解，免得註解裡的說明文字被當成違規。 */
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  test('元件裡不得寫死顏色', () => {
    for (const name of COMPONENT_FILES) {
      const hex = strip(read(name)).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      assert.deepEqual(hex, [], `${name}.css 寫死了顏色：${hex.join(' ')}`);
      const fn = strip(read(name)).match(/\b(rgba?|hsla?)\(/g) ?? [];
      assert.deepEqual(fn, [], `${name}.css 直接用了 ${fn.join(' ')}，顏色一律走 token`);
    }
  });

  test('元件裡不得寫死字級與間距', () => {
    for (const name of COMPONENT_FILES) {
      const css = strip(read(name));
      const rem = css.match(/\b[\d.]+rem\b/g) ?? [];
      // rem 只准出現在 media query 的斷點——那是版面的分界，不是尺度。
      const outside = rem.filter((_, i) => {
        const at = css.indexOf(rem[i] as string);
        return !/@media[^{]*$/.test(css.slice(Math.max(0, at - 60), at));
      });
      assert.deepEqual(outside, [], `${name}.css 寫死了 rem：${outside.join(' ')}`);

      const px = (css.match(/\b[\d.]+px\b/g) ?? []).filter((v) => !ALLOWED_PX.has(v));
      assert.deepEqual(px, [], `${name}.css 寫死了 px：${px.join(' ')}`);
    }
  });

  test('元件裡不得寫死陰影與動效時間', () => {
    for (const name of COMPONENT_FILES) {
      const css = strip(read(name));
      const ms = css.match(/\b\d+m?s\b/g) ?? [];
      assert.deepEqual(ms, [], `${name}.css 寫死了時間：${ms.join(' ')}`);
      // lookahead 要包住空白、而且緊接在冒號後面。寫成 `\s*(?!var\()` 會留一個
      // 回溯的洞：\s* 匹配零個字元之後，lookahead 從空格前開始看，於是永遠成立。
      assert.ok(!/box-shadow:(?!\s*var\()/.test(css), `${name}.css 的陰影要走 --shadow-*`);
    }
  });

  test('尺度收斂到規格給的那幾段', () => {
    const tokens = read('tokens');
    // U29：間距只有九段。
    const values = (re: RegExp) => [...tokens.matchAll(re)].map((m) => Number(m[1]));
    assert.deepEqual(values(/--sp-\d+:\s*(\d+)px/g), [4, 8, 12, 16, 24, 32, 40, 56, 80]);
    // U28：字級只有四級，不得出現第五級。
    assert.deepEqual(values(/--fs-\d+:\s*(\d+)px/g), [13, 15, 17, 22]);
  });

  test('層疊順序是明說的，不靠 <link> 的先後', () => {
    assert.match(read('tokens'), /@layer tokens, base, shell, components;/);
    for (const name of COMPONENT_FILES) {
      assert.match(read(name), /@layer (base|shell|components) \{/, `${name}.css 沒有進層`);
    }
  });
});

describe('分欄的斷點', () => {
  const css = readCss();
  // 分欄的拖曳跟引用選取一樣，只在有來源面板時存在，所以兩者同一支檔案。
  const js = fs.readFileSync('public/js/sourcepane.js', 'utf8');

  test('CSS 與 JS 講的是同一條線', () => {
    // 版面由 CSS 切換、拖曳比例由 JS 記錄，兩邊對不上就會存錯方向的比例。
    const fromCss = css.match(/@media \(min-width: ([\d.]+)rem\) \{\s*\.split \{/);
    const fromJs = js.match(/matchMedia\('\(min-width: ([\d.]+)rem\)'\)/);
    assert.ok(fromCss, 'CSS 裡找不到分欄的 media query');
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
