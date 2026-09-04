import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import MarkdownIt from 'markdown-it';

/** 伺服器端渲染：模板、Markdown、以及少數輸出用的小工具。 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const VIEWS_DIR = path.join(here, 'views');
export const PUBLIC_DIR = path.join(here, '..', '..', 'public');

export const eta = new Eta({ views: VIEWS_DIR, cache: process.env.NODE_ENV === 'production' });

// html: false → 內文裡的原始 HTML 會被跳脫。這是唯一會渲染使用者內容的地方。
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/**
 * 給每個頂層區塊掛上 b0、b1、b2……
 *
 * 引用別人的卡片時，連結會寫成 /c/{id}#b3，指到原文的第 3 個區塊。
 * 卡片建立五分鐘後就不可變，所以第 3 個區塊永遠是第 3 個區塊，
 * 這個錨點不會腐爛。跳轉靠瀏覽器原生的錨點，標記靠 CSS 的 :target，
 * 兩邊都不需要 JS。
 */
md.core.ruler.push('block_anchor', (state) => {
  let n = 0;
  for (const t of state.tokens) {
    if (t.level === 0 && t.block && t.nesting >= 0) {
      t.attrSet('id', `b${n}`);
      t.attrSet('data-b', String(n));
      n += 1;
    }
  }
  return true;
});

export function renderMarkdown(src: string): string {
  return md.render(src);
}

/** 只讓 http/https 進到 href，擋掉 javascript: 之類的東西。 */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export interface PageOptions {
  title: string;
  nav?: string;
  /** 讓搜尋框帶回目前的查詢字串。 */
  q?: string;
  /** 右下角的新增鈕。false 是不顯示，to 是要預先連上的卡片。 */
  fab?: false | { to?: string };
  /** 側欄的最近卡片。由路由填，模板直接用。 */
  recent?: { id: string; title: string }[];
  /** 目前正在看的卡片，用來把側欄裡對應的那一列標起來。 */
  activeId?: string;
}

export function renderPage(view: string, data: Record<string, unknown>, opts: PageOptions): string {
  const body = eta.render(view, data);
  const fab = opts.fab === false ? null : (opts.fab ?? {});
  return eta.render('layout', { ...opts, fab, body });
}
