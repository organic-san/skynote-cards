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
 * 這種連結來自來源面板的「引用」鈕，那條路徑一定帶著一條指回原文的結構化連結，
 * 而被引用的卡片立刻定案（R6）——所以第 3 個區塊永遠是第 3 個區塊，
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

/**
 * 待辦勾選（v3 §2）：清單項目開頭的 `[ ]` 與 `[x]`（`[X]` 同義）。
 *
 * 標記要緊接在清單記號之後，而且後面是空白或行尾——跟 GitHub 的寫法一致，
 * 下載的 .md 拿到別處仍然是待辦清單。`[x](網址)` 是連結，不是標記；
 * 行首沒有清單記號的 `[ ] 事情` 也不是。
 *
 * 判斷用的是 markdown-it 自己的解析結果，不另寫正規表示式去掃原文：
 * 程式碼區塊裡的 `- [ ]` 不是標記，兩套判斷遲早會對不上。渲染（這條規則）
 * 與定位（下面的 taskMarks）因此讀的是同一份 token。
 *
 * 核取方塊一律印成 disabled。能不能勾是卡片頁的事（js/tasks.js 會打開它），
 * 來源面板與沒有 JS 的頁面就停在唯讀。
 */
const TASK_RE = /^\[([ xX])\](?=\s|$)/;

md.core.ruler.push('task_mark', (state) => {
  const tokens = state.tokens;
  let k = 0;
  for (let i = 2; i < tokens.length; i += 1) {
    const inline = tokens[i];
    // 清單項目的第一個段落。tight list 的段落是 hidden，但 token 照樣在。
    if (
      inline?.type !== 'inline' ||
      tokens[i - 1]?.type !== 'paragraph_open' ||
      tokens[i - 2]?.type !== 'list_item_open'
    ) {
      continue;
    }
    const first = inline.children?.[0];
    const m = first && first.type === 'text' ? TASK_RE.exec(first.content) : null;
    if (!first || !m || !inline.children) continue;

    first.content = first.content.slice(m[0].length);
    const box = new state.Token('task_mark', 'input', 0);
    // 行號給 taskMarks 用：原文裡的位置要從這一行找回來。
    box.meta = { k, checked: m[1] !== ' ', line: inline.map?.[0] ?? -1 };
    inline.children.unshift(box);
    tokens[i - 2]?.attrJoin('class', 'task');
    k += 1;
  }
  return true;
});

md.renderer.rules.task_mark = (tokens, idx) => {
  const meta = tokens[idx]?.meta as { k: number; checked: boolean };
  return `<input type="checkbox" class="taskbox" data-task="${meta.k}"${meta.checked ? ' checked' : ''} disabled>`;
};

export function renderMarkdown(src: string): string {
  return md.render(src);
}

/**
 * 每一個勾選標記在原文裡的位置：方括號中間那一格的字元位移，依出現順序。
 * 第 k 個就是畫面上 `data-task="k"` 的那一個。
 *
 * 解析器給的是行號，不是字元位移，所以這裡把行號換回原文的位置：
 * 那一行裡的第一個 `[` 就是標記——在它之前只可能是縮排、`>` 與清單記號，
 * 這幾樣都不含方括號。換行照 markdown-it 的切法算（`\r\n`、`\r`、`\n`），
 * 碎片的文字可能帶著表單送來的 `\r\n`。
 */
export function taskMarks(src: string): number[] {
  const starts = [0];
  const breaks = /\r\n?|\n/g;
  for (let m = breaks.exec(src); m !== null; m = breaks.exec(src)) {
    starts.push(m.index + m[0].length);
  }

  const out: number[] = [];
  for (const t of md.parse(src, {})) {
    for (const c of t.children ?? []) {
      if (c.type !== 'task_mark') continue;
      const start = starts[(c.meta as { line: number }).line];
      const at = start === undefined ? -1 : src.indexOf('[', start);
      out.push(at === -1 ? -1 : at + 1);
    }
  }
  return out;
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
  /**
   * 側欄下半列什麼（v3 §5）：文章一覽列最近的標籤（預設）；卡片頁與編輯介面
   * （編輯頁、建立表單）列最近的卡片。路由只說要哪一種，清單由 shell 填。
   */
  side?: 'tags' | 'cards';
  /** 側欄的最近標籤，最近使用的排前面。 */
  sidetags?: string[];
  /** 側欄的最近卡片。 */
  recent?: { id: string; title: string; type: string }[];
  /** 正在看或正在改的那張卡，用來把側欄裡對應的那一列標起來。 */
  activeId?: string;
  /**
   * 首頁 `?tag=` 篩選生效時的那個標籤。
   *
   * 它會一路走到右下的隨手記：在一堆同標籤的卡片裡看到什麼想記下來，
   * 那一則幾乎必然屬於同一堆。要使用者記完再回頭補標籤，
   * 是把一個已經知道的答案再問一次。側欄的標籤清單也用它標出目前那一個。
   */
  tag?: string;
}

export function renderPage(view: string, data: Record<string, unknown>, opts: PageOptions): string {
  const body = eta.render(view, data);
  const fab = opts.fab === false ? null : (opts.fab ?? {});
  return eta.render('layout', { ...opts, fab, body });
}
