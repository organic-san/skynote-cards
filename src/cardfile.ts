import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Card, CardMeta } from './types.ts';
import { isCardType, isProvenance, isRel } from './types.ts';

/**
 * 卡片檔案的讀寫。檔案是唯一真相。
 * 這是唯一碰 cards/ 的模組，寫入動作只有兩種：建立、五分鐘時窗內重寫。
 */

export function cardsDir(corpusPath: string): string {
  return path.join(corpusPath, 'cards');
}

export function cardPath(corpusPath: string, id: string): string {
  return path.join(cardsDir(corpusPath), `${id}.md`);
}

export function cardExists(corpusPath: string, id: string): boolean {
  return fs.existsSync(cardPath(corpusPath, id));
}

/** cards/ 下所有卡片的 ID，依 ID 由小到大。 */
export function listCardIds(corpusPath: string): string[] {
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => {
      // 檔名不保證是合法 ID，BigInt 可能丟例外，退回字串比較。
      try {
        const x = BigInt(a);
        const y = BigInt(b);
        return x < y ? -1 : x > y ? 1 : 0;
      } catch {
        return a < b ? -1 : a > b ? 1 : 0;
      }
    });
}

export function countCardFiles(corpusPath: string): number {
  const dir = cardsDir(corpusPath);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

// ---------------------------------------------------------------- 序列化

/**
 * frontmatter 自己序列化：欄位順序與引號風格必須固定，
 * 檔案的長相不該隨著某個函式庫換版本而改變。
 */
function needsQuote(s: string, inFlow: boolean): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:\s/.test(s) || s.endsWith(':')) return true;
  if (/\s#/.test(s)) return true;
  if (/[\n\r\t]/.test(s)) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  if (/^[-+]?[0-9.]+([eE][-+]?[0-9]+)?$/.test(s)) return true;
  if (inFlow && /[,[\]{}]/.test(s)) return true;
  return false;
}

function yamlScalar(s: string, opts: { inFlow?: boolean; force?: boolean } = {}): string {
  if (opts.force || needsQuote(s, opts.inFlow ?? false)) {
    // JSON 的跳脫是 YAML double-quoted scalar 的子集，可以直接用。
    return JSON.stringify(s);
  }
  return s;
}

function yamlNullable(v: string | null): string {
  return v === null ? 'null' : yamlScalar(v);
}

export function serializeCard(card: Card): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${yamlScalar(card.id, { force: true })}`);
  lines.push(`type: ${card.type}`);
  lines.push(`created: ${yamlScalar(card.created, { force: true })}`);
  lines.push(`title: ${yamlScalar(card.title)}`);
  lines.push(
    card.tags.length === 0
      ? 'tags: []'
      : `tags: [${card.tags.map((t) => yamlScalar(t, { inFlow: true })).join(', ')}]`,
  );
  lines.push(`url: ${yamlNullable(card.url)}`);
  lines.push(`provenance: ${yamlNullable(card.provenance)}`);
  lines.push(`revised: ${card.revised === null ? 'null' : yamlScalar(card.revised, { force: true })}`);
  if (card.links.length === 0) {
    lines.push('links: []');
  } else {
    lines.push('links:');
    for (const l of card.links) {
      lines.push(`  - rel: ${l.rel}`);
      lines.push(`    to: ${yamlScalar(l.to, { force: true })}`);
    }
  }
  lines.push('---');
  lines.push('');
  const body = card.body.replace(/\r\n/g, '\n');
  return `${lines.join('\n')}${body}${body.endsWith('\n') ? '' : '\n'}`;
}

// ---------------------------------------------------------------- 解析

export class CardParseError extends Error {}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  // 未加引號的 ISO 時間會被 YAML 解析成 Date，轉回字串。
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

/**
 * 解析一份卡片檔。結構壞掉就丟 CardParseError，
 * 重建索引時會接住它、記進失敗清單，不中斷整體流程。
 */
export function parseCard(raw: string, fallbackId: string): Card {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;

  const id = asString(d.id) ?? fallbackId;
  const type = d.type;
  if (!isCardType(type)) throw new CardParseError(`type 不合法：${String(d.type)}`);

  const created = asString(d.created);
  if (!created) throw new CardParseError('created 缺少或不是字串');

  const title = asString(d.title);
  if (title === null || title.trim() === '') throw new CardParseError('title 缺少或為空');

  let tags: string[] = [];
  if (Array.isArray(d.tags)) {
    tags = d.tags.map((t) => asString(t)).filter((t): t is string => t !== null);
  } else if (d.tags != null) {
    throw new CardParseError('tags 不是陣列');
  }

  const provenanceRaw = asString(d.provenance);
  if (provenanceRaw !== null && !isProvenance(provenanceRaw)) {
    throw new CardParseError(`provenance 不合法：${provenanceRaw}`);
  }

  const links: Card['links'] = [];
  if (Array.isArray(d.links)) {
    for (const l of d.links) {
      if (typeof l !== 'object' || l === null) throw new CardParseError('links 項目不是物件');
      const rel = (l as Record<string, unknown>).rel;
      const to = asString((l as Record<string, unknown>).to);
      if (!isRel(rel)) throw new CardParseError(`rel 不在詞彙表內：${String(rel)}`);
      if (to === null) throw new CardParseError('link.to 缺少');
      links.push({ rel, to });
    }
  } else if (d.links != null) {
    throw new CardParseError('links 不是陣列');
  }

  return {
    id,
    type,
    created,
    title,
    tags,
    url: asString(d.url),
    provenance: provenanceRaw,
    revised: asString(d.revised),
    links,
    body: parsed.content.replace(/^\n+/, ''),
  };
}

export function readCard(corpusPath: string, id: string): Card {
  const raw = fs.readFileSync(cardPath(corpusPath, id), 'utf8');
  return parseCard(raw, id);
}

/** 只取 frontmatter。 */
export function readCardMeta(corpusPath: string, id: string): CardMeta {
  const c = readCard(corpusPath, id);
  const { body: _body, ...meta } = c;
  return meta;
}

// ---------------------------------------------------------------- 寫入

/**
 * 先寫 .tmp、fsync、再 rename。
 * 任何時刻中斷，cards/ 下都不會出現半個檔案。
 */
export function writeCardFile(corpusPath: string, card: Card): string {
  const dir = cardsDir(corpusPath);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = cardPath(corpusPath, card.id);
  const tmpPath = `${finalPath}.tmp`;
  const content = serializeCard(card);

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);

  // 目錄項目也要落地，否則 crash 後 rename 可能不見。
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // 有些平台不允許 fsync 目錄，忽略。
  }
  return finalPath;
}
