/**
 * 把外部 URL 變成頁面上直接看得到的東西。
 *
 * 只認白名單裡的幾種，而且只用 iframe 與 img，不載入任何第三方腳本。
 * 認不出來的一律退回一個普通連結——寧可少嵌，不要為了嵌某個站
 * 把別人的 JS 拉進這個頁面。
 */

export type EmbedKind = 'youtube' | 'image' | 'pdf' | null;

export interface Embed {
  kind: EmbedKind;
  /** 要塞進 iframe / img 的位址，已經確認是 https。 */
  src: string;
}

function httpsUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** YouTube 的三種常見網址形狀。 */
function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1) || null;
  if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const shorts = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(u.pathname);
  return shorts?.[1] ?? null;
}

const ID_RE = /^[\w-]{5,64}$/;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function embedFor(raw: string | null): Embed | null {
  const u = httpsUrl(raw);
  if (!u) return null;

  const vid = youtubeId(u);
  if (vid && ID_RE.test(vid)) {
    const start = u.searchParams.get('t');
    const q = start && /^\d+s?$/.test(start) ? `?start=${parseInt(start, 10)}` : '';
    return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${vid}${q}` };
  }

  if (IMAGE_RE.test(u.pathname)) return { kind: 'image', src: u.href };
  if (/\.pdf$/i.test(u.pathname)) return { kind: 'pdf', src: u.href };

  return null;
}
