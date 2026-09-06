import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { cardExists, countCardFiles, readCard } from '../store/files.ts';
import { CardIndex, type CardRow, type CardRowWithTags } from '../store/index/index.ts';
import { GitBackup } from '../store/backup.ts';
import { isValidIdFormat } from '../domain/id.ts';
import { embedFor } from './embed.ts';
import { renderMarkdown, renderPage, safeHref, type PageOptions } from './render.ts';
import {
  FORM_SPEC_TABLE,
  actionsFor,
  formTitle,
  headingOf,
  clip,
  ruminationView,
  flattenThread,
  formSpec,
  relLabel,
  relOptions,
  stampFull,
  stampShort,
  toItem,
} from './present.ts';
import {
  CARD_TYPES,
  PROVENANCES,
  TYPE_LABELS,
  allowedTargets,
  isCardType,
  isRel,
  type CardDraft,
  type CardType,
} from '../domain/types.ts';
import { fleetingDraft, fleetingText, quickDraft } from '../domain/card.ts';
import { LOCKED_MESSAGE } from '../domain/rules.ts';
import {
  createCard,
  deleteCard,
  ruminationFor,
  updateCard,
  type CardServiceDeps,
} from '../service/cards.ts';
import * as lists from '../service/lists.ts';

/** HTTP 這一層：解析請求、呼叫下面、選一份模板。業務判斷不放在這裡。 */

/**
 * 引用串一次撈幾層。上游與下游預設展開的深度不同：
 * 上游要的是「馬上知道我在回應誰」，一層就夠；
 * 下游是主動探索，多開一層。
 */
const THREAD_DEPTH = 4;
const UPSTREAM_OPEN = 0;
const DOWNSTREAM_OPEN = 1;

// ---------------------------------------------------------------- 請求解析

function wantsJson(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('application/json')) return true;
  const ct = String(req.headers['content-type'] ?? '');
  return ct.includes('application/json') && !accept.includes('text/html');
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}

/**
 * 一行字串切成標籤。**只用空白分隔。**
 *
 * 逗號被推翻了：兩種分隔符並存時，`世界觀, 構想` 與 `世界觀 構想` 長得不一樣
 * 卻是同一件事，掃過去分不出標籤的邊界。只留空白之後，欄位裡看到幾個空白
 * 就是幾個標籤。
 *
 * 代價是習慣性打的逗號會變成標籤的一部分，而卡片過了反芻期就改不動了——
 * 所以那不是靜默吞下去，是一條會報錯的規則（見 rules.ts 的 checkTagChars）。
 */
function splitTags(line: string): string[] {
  return line
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function normalizeDraft(body: unknown): CardDraft {
  const b = (body ?? {}) as Record<string, unknown>;

  // 碎片的表單只有一個大文字框。那段話存進 title，body 留空——
  // 欄位反轉只在 fleetingDraft 裡定義一次，這裡照著用。
  //
  // 只有那張表單會送 quick_body。直接照欄位送上來的（API、測試）走原路，
  // 否則「型別是 fleeting」會被當成「一定來自那張表單」，把 title 洗掉。
  const single =
    b.type === 'fleeting' && b.quick_body !== undefined
      ? fleetingDraft(String(b.quick_body))
      : null;

  let tags: string[];
  if (Array.isArray(b.tags)) tags = b.tags.map((t) => String(t));
  else tags = splitTags(String(b.tags ?? ''));

  let links: { rel: string; to: string }[];
  if (Array.isArray(b.links)) {
    links = b.links.map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      return { rel: String(o.rel ?? ''), to: String(o.to ?? '') };
    });
  } else {
    const rels = asArray(b.link_rel);
    const tos = asArray(b.link_to);
    links = rels.map((rel, i) => ({ rel, to: (tos[i] ?? '').trim() })).filter((l) => l.to !== '');
  }

  return {
    type: String(b.type ?? ''),
    title: single ? single.title : String(b.title ?? ''),
    body: single ? single.body : String(b.body ?? ''),
    tags,
    url: b.url === undefined || b.url === null ? null : String(b.url),
    provenance: b.provenance === undefined || b.provenance === null ? null : String(b.provenance),
    source_author: b.source_author == null ? null : String(b.source_author),
    source_date: b.source_date == null ? null : String(b.source_date),
    links,
  };
}

/**
 * 建立完之後去哪裡。
 *
 * 一般是新卡片頁——你要確認寫出來的東西長什麼樣子。碎片沒有這個需要：
 * 它的標題就是它的全部內容，剛才那個輸入框裡已經看過一次了。
 */
function afterCreate(type: string, id: string, from?: string): string {
  if (type === 'fleeting') return '/';
  return from ? `/c/${id}?from=${from}` : `/c/${id}`;
}

// ---------------------------------------------------------------- 路由

export function registerRoutes(
  app: FastifyInstance,
  index: CardIndex,
  git: GitBackup,
  config: Config,
): void {
  const cards: CardServiceDeps = {
    corpusPath: config.corpusPath,
    index,
    git,
    logger: { error: (msg) => app.log.error(msg) },
    editWindowMs: config.editWindowMs,
  };

  const html = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).type('text/html; charset=utf-8').send(body);

  /**
   * 每一頁的側欄都帶著工作狀態的四份清單與最近的卡片，所以統一從這裡出去。
   * 清單的名字與去處在這裡定義一次，模板只負責 forEach。
   */
  const shell = (view: string, data: Record<string, unknown>, opts: PageOptions) => {
    return renderPage(view, data, {
      ...opts,
      // U9：不掛數量。這些清單實務上不會歸零，數字提供不了「還剩多少」的訊號，
      // 只是每次進站都在閃一個不會變的數；清單本身的長度就是它的量。
      // 連帶把每個請求的四次 COUNT(*) 一起省掉。
      lists: [
        { nav: 'pending', href: '/pending', name: '待思考' },
        { nav: 'loose', href: '/loose', name: '初步想法' },
        // U8：側欄這項是「fleeting 且無入向連結」，跟首頁篩選列的「碎片」
        // （全部 fleeting）不是同一個集合，同名會讓兩處的數字對不起來。
        { nav: 'fleeting', href: '/fleeting', name: '雜筆' },
        { nav: 'settling', href: '/settling', name: '沉澱' },
      ],
      recent: lists.recent(index).map((r) => ({ id: r.id, title: r.title, type: r.type })),
    });
  };

  // ---- 時間逆序的卡片流

  app.get('/', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const type = CARD_TYPES.includes(q.type as CardType) ? q.type : undefined;
    const tag = q.tag && q.tag !== '' ? q.tag : undefined;
    const page = Math.max(1, Number(q.page ?? 1) || 1);

    const { rows, total, pages } = lists.feed(index, { type, tag, page });

    const parts: string[] = [];
    if (type) parts.push(`type=${encodeURIComponent(type)}`);
    if (tag) parts.push(`tag=${encodeURIComponent(tag)}`);
    const baseQuery = `/?${parts.length ? `${parts.join('&')}&` : ''}`;

    return html(
      reply,
      shell(
        'feed',
        {
          items: lists.decorate(index, rows).map(toItem),
          total,
          type,
          tag,
          types: CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
          tagQuery: tag ? `&tag=${encodeURIComponent(tag)}` : '',
          baseQuery,
          page,
          pages,
        },
        { title: tag ? `#${tag}` : 'cards', nav: 'feed' },
      ),
    );
  });

  // ---- 建立

  const newFormPage = (
    values: Record<string, string>,
    links: {
      rel: string;
      to: string;
      title?: string | null;
      /** 目標的型別。收窄 rel 選項要用，不顯示。 */
      targetType?: string | null;
      fixed?: boolean;
    }[],
    opts: { replyTo?: string; errors?: string[]; source?: CardRowWithTags | null } = {},
  ) =>
    shell(
      'new',
      {
        values: {
          type: '',
          rel: '',
          title: '',
          body: '',
          tags: '',
          url: '',
          provenance: '',
          source_author: '',
          source_date: '',
          ...values,
        },
        links,
        errors: opts.errors ?? [],
        replyTo: opts.replyTo ?? '',
        source: opts.source
          ? {
              id: opts.source.id,
              type: opts.source.type,
              typeLabel: TYPE_LABELS[opts.source.type as CardType] ?? opts.source.type,
              heading: headingOf(opts.source),
              title: opts.source.title,
              tags: opts.source.tags,
              date: stampShort(opts.source.created),
              body_html: renderMarkdown(
                opts.source.type === 'fleeting'
                  ? fleetingText(opts.source)
                  : opts.source.body,
              ),
              provenance: opts.source.provenance === 'default' ? null : opts.source.provenance,
            }
          : null,
        // U14：說出這是什麼動作，而且在送出**前**就看得到。
        action: formTitle(values.type ?? '', values.rel ?? '', opts.source ?? null),
        types: CARD_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] })),
        // 型別由入口決定時就鎖住：那些入口同時預填了型別與那條連結，
        // 改了型別，預填的關係多半就不再合法，表單會變成一張送不出去的表，
        // 而畫面上看不出為什麼。只有裸的 /new 才需要選。
        locked: (values.type ?? '') !== '',
        typeLabel: TYPE_LABELS[(values.type ?? '') as CardType] ?? '',
        // 每一列各自依自己的目標收窄；沒有目標的用整組。
        rels: relOptions(values.type ?? ''),
        rowRels: links.map((l) => relOptions(values.type ?? '', l.targetType ?? null)),
        spec: formSpec(values.type ?? ''),
        specs: FORM_SPEC_TABLE,
        relTable: Object.fromEntries(CARD_TYPES.map((t) => [t, relOptions(t)])),
        provenances: PROVENANCES,
        // 標籤推薦：直接嵌在頁面裡，不開端點——標籤表很小，沒有網路往返的必要。
        tags_all: lists.tagCounts(index),
      },
      { title: '新增', fab: false },
    );

  app.get('/new', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const target = q.to && isValidIdFormat(q.to) ? index.getCard(q.to) : null;
    const type = isCardType(q.type) ? q.type : '';

    // 入口把型別與 rel 都填好了，所以這裡只驗一次「這個組合合法嗎」——
    // 而且要連目標的型別一起驗：`thinking` 能用 `refutes`，但不能指向
    // 一份 original。不合法就退回沒有預填連結的空表單，
    // 而不是給一張送得出去的樣子、卻一定被規則擋下來的表。
    const rel =
      target &&
      isRel(q.rel) &&
      isCardType(type) &&
      isCardType(target.type) &&
      (allowedTargets(type, q.rel)?.includes(target.type) ?? false)
        ? q.rel
        : null;
    const links =
      target && rel
        ? [{ rel, to: target.id, title: target.title, targetType: target.type, fixed: true }]
        : [];

    // 完整化：把碎片那段文字帶進新卡的內文（A.5 的欄位反轉在這裡收尾）。
    const body =
      target && rel === 'updates' && target.type === 'fleeting' ? fleetingText(target) : '';

    return html(
      reply,
      newFormPage({ type, body, rel: rel ?? '' }, links, {
        replyTo: target?.id,
        source: target,
      }),
    );
  });

  app.post('/new', async (req, reply) => {
    const draft = normalizeDraft(req.body);
    // 表單裡帶著它是從哪張卡開出來的，驗證失敗退回時來源面板才能跟著回來。
    const replyTo = String((req.body as Record<string, unknown> | undefined)?.reply_to ?? '');
    const source = isValidIdFormat(replyTo) ? index.getCard(replyTo) : null;

    const reject = (errors: string[]) => {
      if (wantsJson(req)) return reply.code(400).send({ ok: false, errors });
      return html(
        reply,
        newFormPage(
          {
            type: draft.type,
            title: draft.title,
            body: draft.body,
            tags: draft.tags.join(', '),
            url: draft.url ?? '',
            provenance: draft.provenance ?? '',
          },
          draft.links.map((l) => {
            const t = index.getCard(l.to);
            return { ...l, title: t?.title ?? null, targetType: t?.type ?? null };
          }),
          { errors, source, replyTo: source?.id },
        ),
        400,
      );
    };

    const result = createCard(cards, draft);
    if (!result.ok) return reject(result.errors);

    const { id } = result.card;
    // 送出後導向新卡片頁，頂端顯示一行「已從 ⟨來源卡標題⟩ 建立」，
    // 讓來源可一鍵返回——建立一張卡幾乎總是為了回到剛才在看的東西。
    //
    // 碎片例外：它的標題就是它的全部內容，跳過去只是把同一句話再讀一次。
    // 回首頁反而讓「連著記三句」變順。
    const location = afterCreate(result.card.type, id, source?.id);
    if (wantsJson(req)) {
      return reply.code(302).header('location', location).send({ ok: true, id });
    }
    return reply.code(302).header('location', location).send();
  });

  /**
   * 右下浮動按鈕：隨手記。
   *
   * 兩個欄位加一個送出鍵，沒有型別選單、沒有標籤、沒有連結。
   * 型別由標題決定（見 quickDraft）。這條路徑刻意跟 /new 分開——
   * 把外面的東西收進來，和把腦袋裡的東西倒出來，是截然不同的兩種動機，
   * 共用一顆按鈕會讓兩邊都變鈍。
   */
  app.post('/quick', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;

    /*
      隨手記展開為完整表單（鎖定 thinking 型別）。
      走 POST 傳遞已輸入內容，避免草稿出現在網址或日誌中。
    */
    if (b.expand !== undefined) {
      return html(
        reply,
        newFormPage(
          { type: 'thinking', title: String(b.title ?? ''), body: String(b.body ?? '') },
          [],
        ),
      );
    }

    const picked = quickDraft(String(b.title ?? ''), String(b.body ?? ''));

    const result = createCard(cards, {
      ...picked,
      tags: [],
      url: null,
      provenance: null,
      source_author: null,
      source_date: null,
      links: [],
    });

    if (!result.ok) {
      if (wantsJson(req)) return reply.code(400).send({ ok: false, errors: result.errors });
      return html(
        reply,
        shell('message', { message: result.errors.join('；') }, { title: '沒寫成' }),
        400,
      );
    }
    const { id } = result.card;
    const location = afterCreate(result.card.type, id);
    if (wantsJson(req)) {
      return reply.code(302).header('location', location).send({ ok: true, id });
    }
    return reply.code(302).header('location', location).send();
  });

  // ---- 檢視

  app.get('/c/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id)) return reply.callNotFound();
    const card = index.getCard(id);
    if (!card) return reply.callNotFound();

    const out = index.outLinks(id);
    const fromId = (req.query as Record<string, string | undefined>).from;
    const raw = fromId && isValidIdFormat(fromId) ? index.getCard(fromId) : null;
    // 「已從 X 建立」是一句話，所以 X 在這裡截（見 present.ts 的 clip）。
    const from = raw ? { id: raw.id, title: clip(raw.title, 24) } : null;

    // D.5 與「還能不能編輯」是同一個狀態，所以只問一次。
    const rumination = ruminationFor(cards, card);

    const upstream = flattenThread(index.linkTree(id, 'out', THREAD_DEPTH), UPSTREAM_OPEN, 'out');
    const downstream = flattenThread(index.linkTree(id, 'in', THREAD_DEPTH), DOWNSTREAM_OPEN, 'in');
    const has_toggles = upstream.some((r) => r.children > 0) || downstream.some((r) => r.children > 0);

    return html(
      reply,
      shell(
        'card',
        {
          card,
          // 碎片沒有標題（headingOf 回 null），那段話改走內文的位置——
          // 它本來就是內容，印成 h1 會得到一面粗體的牆。
          heading: headingOf(card),
          created_display: stampFull(card.created),
          created_short: stampShort(card.created),
          revised_display: card.revised ? stampFull(card.revised) : null,
          provenance: card.provenance === 'default' ? null : card.provenance,
          rumination: ruminationView(rumination),
          url_href: safeHref(card.url),
          embed: embedFor(card.url),
          body_html: renderMarkdown(
            card.type === 'fleeting' ? fleetingText(card) : card.body,
          ),
          upstream,
          downstream,
          has_toggles,
          upstream_count: out.length,
          downstream_count: index.backLinks(id).length,
          type_label: TYPE_LABELS[card.type as CardType] ?? card.type,
          // U27：選取文字帶當前卡片的型別色，因為選取是「引用選取的段落」的前置動作。
          type_slug: card.type,
          from: from ? { id: from.id, title: from.title } : null,
          editable: rumination.open,
        },
        { title: card.title, fab: { actions: actionsFor(card.type, id) }, activeId: id },
      ),
    );
  });

  // ---- 五分鐘時窗內的修改

  app.get('/c/:id/edit', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id) || !cardExists(config.corpusPath, id)) return reply.callNotFound();
    const card = readCard(config.corpusPath, id);
    const out = index.outLinks(id);
    const rumination = ruminationFor(cards, card);
    if (!rumination.open) {
      return html(
        reply,
        shell('message', { message: LOCKED_MESSAGE, back_id: id }, { title: 'locked' }),
        403,
      );
    }
    return html(
      reply,
      shell(
        'edit',
        {
          card,
          type_label: TYPE_LABELS[card.type as CardType] ?? card.type,
          created_display: stampFull(card.created),
          lock_at: rumination.until,
          tags_line: card.tags.join(' '),
          tags_all: lists.tagCounts(index),
          // R7：既有的連結是一份唯讀清單，新增的才是表單列。兩者分開呈現，
          // 因為它們能做的事不一樣——分不開的話「只增不減」就要靠說明去講。
          links: out.map((l) => ({
            rel: l.rel,
            label: relLabel(l.rel, 'out'),
            to: l.id,
            title: l.title,
          })),
          // R8：碎片不得有連結，所以整個區塊不出現（跟建立表單同一張表）。
          can_link: formSpec(card.type).links,
          // links.js 讀的是一張「型別 → 可用關係」的表。這一頁型別是固定的，
          // 所以表裡只有一格。
          rel_table: { [card.type]: relOptions(card.type) },
        },
        { title: 'edit', fab: false },
      ),
    );
  });

  app.put('/c/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id) || !cardExists(config.corpusPath, id)) return reply.callNotFound();

    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = updateCard(cards, id, {
      title: b.title == null ? undefined : String(b.title),
      tags:
        b.tags === undefined
          ? undefined
          : Array.isArray(b.tags)
            ? b.tags.map((t) => String(t))
            : splitTags(String(b.tags)),
      url: b.url === undefined ? undefined : String(b.url ?? ''),
      body: b.body === undefined ? undefined : String(b.body),
      // R7：只有「要新增的」，沒有「完整的 links」——刪除在這條路徑上
      // 沒有表示法，見 service 的 UpdatePatch。
      addLinks: Array.isArray(b.add_links)
        ? (b.add_links as { rel?: string; to?: string }[])
        : undefined,
    });

    if (!result.ok) {
      return reply.code(result.reason === 'locked' ? 403 : 400).send({
        ok: false,
        errors: result.errors,
      });
    }
    return reply.send({ ok: true, id, revised: result.card.revised });
  });

  /**
   * R9：反芻期內、尚未被指向的卡片可以刪除。
   *
   * v1 的「沒有任何 endpoint 能刪除卡片」被推翻（spec G 節：I2 被 D 節修訂）。
   * 理由是 R7——連結只增不減，誤加就收不回；若連整張卡都不能刪，
   * 一次手滑就永久留在語料庫裡。R6 保證被指向的卡片刪不掉，
   * 所以這條路徑永遠不會製造壞連結。
   */
  app.delete('/c/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id) || !cardExists(config.corpusPath, id)) return reply.callNotFound();

    const result = deleteCard(cards, id);
    if (!result.ok) return reply.code(403).send({ ok: false, errors: result.errors });
    return reply.send({ ok: true, id });
  });

  // ---- 標籤、孤兒、搜尋

  app.get('/tags', async (_req, reply) =>
    html(reply, shell('tags', { tags: lists.tagCounts(index) }, { title: 'tags', nav: 'tags' })),
  );

  // ---- 工作狀態的四份清單

  /**
   * 四份清單。
   *
   * `empty` 陳述的是「這份清單問了什麼、答案是沒有」，用的是查詢本身的說法，
   * 不替使用者詮釋——「沒有任何卡片指向的原始資料」是事實，
   * 「收進來但還沒有人接手」是我在替他解讀。清單有東西的時候，
   * 東西本身就是說明，所以那句話只在空的時候出現。
   */
  const WORK_LISTS = [
    {
      nav: 'pending',
      path: '/pending',
      heading: '待思考',
      empty: '沒有任何原始資料是無人指向的。',
      rows: () => lists.pending(index),
    },
    {
      nav: 'loose',
      path: '/loose',
      heading: '初步想法',
      empty: '沒有任何思考是進出皆無連結的。',
      rows: () => lists.looseThinking(index),
    },
    {
      nav: 'fleeting',
      path: '/fleeting',
      heading: '雜筆',
      empty: '沒有任何碎片是無人指向的。',
      rows: () => lists.looseFleeting(index),
    },
    {
      nav: 'settling',
      path: '/settling',
      heading: '沉澱',
      empty: '沒有任何卡片仍在可修改時間內。',
      rows: () => lists.settling(index, config.editWindowMs),
    },
  ] as const;

  for (const l of WORK_LISTS) {
    app.get(l.path, async (_req, reply) => {
      const items = lists.decorate(index, l.rows()).map(toItem);
      return html(
        reply,
        shell(
          'worklist',
          { heading: l.heading, empty: l.empty, items },
          { title: l.heading, nav: l.nav },
        ),
      );
    });
  }

  app.get('/search', async (req, reply) => {
    const q = String((req.query as Record<string, unknown>).q ?? '').trim();
    const items = lists.decorate(index, lists.search(index, q)).map(toItem);
    return html(
      reply,
      shell('search', { q, items, searched: q !== '' }, { title: '搜尋', q, nav: 'search' }),
    );
  });

  app.get('/api/search', async (req, reply) => {
    const qs = req.query as Record<string, unknown>;
    const q = String(qs.q ?? '');
    const limit = Math.min(50, Math.max(1, Number(qs.limit ?? 10) || 10));
    const rows: CardRow[] = lists.picker(index, q, limit);
    return reply.send(
      rows.map((r) => ({ id: r.id, title: r.title, type: r.type, created: r.created })),
    );
  });

  // ---- 維運

  app.post('/_reindex', async (_req, reply) => reply.send(index.rebuild()));

  app.get('/_health', async (_req, reply) => {
    return reply.send({
      cards_files: countCardFiles(config.corpusPath),
      cards_indexed: index.countCards(),
      unpushed_commits: await git.unpushedCount(),
      git: git.status,
      corpus_path: config.corpusPath,
      index_path: config.indexPath,
    });
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (wantsJson(req)) return reply.code(404).send({ ok: false, errors: ['找不到'] });
    return html(reply, shell('message', { message: '沒有這個位置。' }, { title: '404' }), 404);
  });
}
