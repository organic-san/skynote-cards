// 把 temp/draft/*.md 的草稿變成語料庫裡的卡片檔。
//
//   node --experimental-strip-types scripts/import-draft.ts               驗證並報告，不寫
//   node --experimental-strip-types scripts/import-draft.ts --write       寫進 ../skynote-corpus/cards
//   node --experimental-strip-types scripts/import-draft.ts --write --out <dir>
//
// 不走 HTTP：createCard 用 new Date() 當 created（改不了），而這批卡的時間是
// 2021–2026；反芻期與 R6 也都是為互動設計的。但**驗證走同一組規則**——
// validateDraft / validateLinkOrder 就是 UI 用的那兩支，不是「像那組的檢查」。
//
// ID 是決定性的：`(ms - EPOCH) << 22 | hash(ISO)`，沒有亂數。所以同一份草稿
// 重跑會產生完全相同的 ID——發現不對就整批刪掉、改草稿、重跑，不會長出重複卡。
// 這很重要，因為匯入的卡 created 是好幾年前，一進去就過了反芻期，改不動。

import fs from 'node:fs';
import path from 'node:path';
import { serializeCard } from '../src/domain/card.ts';
import { EPOCH, compareIds } from '../src/domain/id.ts';
import { validateDraft, validateLinkOrder } from '../src/domain/rules.ts';
import type { Card, CardType } from '../src/domain/types.ts';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
/** `--flag <值>`。沒給就用預設——indexOf 回 -1 時 +1 會取到 args[0]，所以先問有沒有。 */
function opt(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i > -1 ? (args[i + 1] ?? fallback) : fallback;
}

const IN = opt('--in', 'temp/draft');
const OUT = opt('--out', path.join('..', 'skynote-corpus', 'cards'));

const DIRECTIVE = /^([§¶]) (\S+) (\S+)(.*)$/;

interface Seg {
  file: string;
  line: number;
  cont: boolean;
  iso: string;
  type: string;
  tags: string[];
  text: string;
}

const errors: string[] = [];
const fail = (s: Seg, msg: string) => errors.push(`${s.file}:${s.line}  ${msg}`);

// ------------------------------------------------------------------ 解析

const segs: Seg[] = [];
for (const f of fs.readdirSync(IN).filter((n) => n.endsWith('.md')).sort()) {
  const lines = fs.readFileSync(path.join(IN, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const fileTags = (/^@tags (.*)$/m.exec(lines.join('\n'))?.[1] ?? '').split(/\s+/).filter(Boolean);

  let open: Seg | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (open) {
      open.text = buf.join('\n').trim();
      segs.push(open);
    }
    buf.length = 0;
  };

  lines.forEach((line, i) => {
    const m = DIRECTIVE.exec(line);
    if (!m) {
      if (open) buf.push(line);
      return;
    }
    flush();
    open = {
      file: f,
      line: i + 1,
      cont: m[1] === '¶',
      iso: m[2] as string,
      type: m[3] as string,
      // 檔首的共通標籤在前，那一則自己的接在後面。去重交給 validateDraft。
      tags: [...fileTags, ...(m[4] ?? '').split(/\s+/).filter(Boolean)],
      text: '',
    };
  });
  flush();
}

// ------------------------------------------------------------------ 發號

/** FNV-1a，取 22 位。決定性——同一個時間戳永遠得到同一個低位。 */
function low22(s: string): bigint {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return BigInt(h & 0x3fffff);
}

interface Built {
  seg: Seg;
  id: string;
  card: Card;
}

const built: Built[] = [];
const byId = new Map<string, Seg>();
let prev: Built | null = null;
let prevFile = '';

for (const s of segs) {
  if (s.file !== prevFile) {
    prev = null;
    prevFile = s.file;
  }

  if (s.type === '?') {
    fail(s, '型別還是 ?，你還沒決定');
    prev = null;
    continue;
  }

  const ms = Date.parse(s.iso);
  if (Number.isNaN(ms)) {
    fail(s, `時間讀不出來：${s.iso}`);
    prev = null;
    continue;
  }
  if (BigInt(ms) < EPOCH) {
    fail(s, `時間早於 EPOCH（${new Date(Number(EPOCH)).toISOString()}）`);
    prev = null;
    continue;
  }

  const id = (((BigInt(ms) - EPOCH) << 22n) | low22(s.iso)).toString();
  const clash = byId.get(id);
  if (clash) {
    // 時間戳一樣就撞號。多半是拆一則的時候把時間複製過去忘了改。
    fail(s, `ID 跟 ${clash.file}:${clash.line} 撞了——兩則的時間戳一樣`);
    prev = null;
    continue;
  }
  byId.set(id, s);

  // 碎片的欄位反轉：整段話存進 title，body 留空。
  const isFleeting = s.type === 'fleeting';
  const lines = s.text.split('\n');
  const title = isFleeting ? s.text : (lines[0] ?? '').trim();
  const body = isFleeting ? '' : lines.slice(1).join('\n').trim();

  const links: { rel: string; to: string }[] = [];
  if (s.cont) {
    if (!prev) fail(s, '¶ 但上面沒有東西可以指');
    else if (compareIds(prev.id, id) >= 0) fail(s, '¶ 指向的那一則不比自己舊');
    else links.push({ rel: 'related', to: prev.id });
  }

  // 驗證走 UI 那一組，不是像那組的檢查。R2（碎片不得有連結）、R3 的矩陣、
  // 標題非空、標籤不含逗號、連結順序，全部在裡面。
  const checked = validateDraft(
    { type: s.type, title, body, tags: s.tags, url: null, provenance: null, links },
    {
      cardExists: (t) => byId.has(t),
      typeOf: (t) => (built.find((b) => b.id === t)?.card.type as CardType) ?? null,
    },
  );
  const orderErrors = validateLinkOrder(id, links.map((l) => ({ rel: l.rel as never, to: l.to })));
  const all = [...checked.errors, ...orderErrors];
  if (all.length > 0 || !checked.value) {
    for (const e of all) fail(s, e);
    prev = null;
    continue;
  }

  const card: Card = {
    id,
    type: checked.value.type,
    created: new Date(ms).toISOString(),
    title: checked.value.title,
    tags: checked.value.tags,
    url: null,
    provenance: null,
    source_author: null,
    source_date: null,
    revised: null,
    links: checked.value.links,
    body,
  };
  const b = { seg: s, id, card };
  built.push(b);
  prev = b;
}

// ------------------------------------------------------------------ 報告

const byType = built.reduce<Record<string, number>>((acc, b) => {
  acc[b.card.type] = (acc[b.card.type] ?? 0) + 1;
  return acc;
}, {});
const linked = built.filter((b) => b.card.links.length > 0).length;
const tags = new Set(built.flatMap((b) => b.card.tags));

console.log(`來源 ${IN}：${segs.length} 段`);
console.log(`  建得起來 ${built.length}：${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
console.log(`  帶 related 的 ${linked} 張，標籤 ${tags.size} 種`);
if (built.length > 0) {
  const sorted = [...built].sort((a, b) => compareIds(a.id, b.id));
  console.log(`  時間 ${sorted[0]!.card.created.slice(0, 10)} → ${sorted.at(-1)!.card.created.slice(0, 10)}`);
}

if (errors.length > 0) {
  console.log(`\n擋下來 ${errors.length} 條：`);
  for (const e of errors) console.log(`  ${e}`);
  console.log('\n有東西沒過，什麼都不寫。');
  process.exit(1);
}

if (!WRITE) {
  console.log('\n全部通過。要真的寫出去加 --write。');
  process.exit(0);
}

// ------------------------------------------------------------------ 寫出

fs.mkdirSync(OUT, { recursive: true });
const existing = fs.readdirSync(OUT).filter((n) => n.endsWith('.md'));
const mine = new Set(built.map((b) => `${b.id}.md`));
const foreign = existing.filter((n) => !mine.has(n));
if (foreign.length > 0 && !FORCE) {
  console.log(`\n${OUT} 裡有 ${foreign.length} 張不是這次匯入產生的卡：`);
  for (const n of foreign.slice(0, 10)) console.log(`  ${n}`);
  console.log('\n重跑會覆蓋同名的，但這幾張不會被動到。確定的話加 --force。');
  process.exit(1);
}

for (const b of built) {
  fs.writeFileSync(path.join(OUT, `${b.id}.md`), serializeCard(b.card), 'utf8');
}
console.log(`\n寫出 ${built.length} 張到 ${OUT}`);
console.log('索引沒有動——那邊砍掉 index.db 重啟就會自己重建。');
