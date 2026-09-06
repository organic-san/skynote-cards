import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import MarkdownIt from 'markdown-it';

/** 伺服器端渲染：模板、Markdown、以及少數輸出用的小工具。 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const VIEWS_DIR = path.join(here, 'views');
export const PUBLIC_DIR = path.join(here, '..', '..', 'public');

export const eta = new Eta({ views: VIEWS_DIR, cache: process.env.NODE_ENV === 'production' });

/*
  html: false → 內文裡的原始 HTML 會被跳脫。這是唯一會渲染使用者內容的地方。

  breaks: true → **單一換行就是換行**，不照 CommonMark 併成一個空格。

  這是刻意偏離標準的。CommonMark 那條規則服務的是「原始碼裡硬斷行、輸出時
  重新排版」的寫作方式，而這裡的內文是打在 textarea 裡的——沒有人在瀏覽器的
  文字框裡把散文斷在第 80 個字元。在這個輸入情境下，一個換行就是一次刻意的
  換行，併掉它等於把使用者寫下的結構抹掉。

  匯入的那批尤其明顯：Discord 的訊息大量是一行一個要點的列表，
  併成一段之後整段就讀不出結構了。
*/
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });

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
  /**
   * 右下角的按鈕。false 是不顯示。
   * 帶 actions 就是卡片頁的動作選單（C.3），不帶就是隨手記（C.2）——
   * 兩者都在右下，但問的是完全不同的問題。
   */
  fab?: false | { actions?: { label: string; href: string; rel: string }[] };
  /** 側欄的工作狀態清單。由路由填，模板只 forEach。 */
  lists?: { nav: string; href: string; name: string }[];
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
