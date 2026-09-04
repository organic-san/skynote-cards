import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { cardExists, countCardFiles, readCard } from '../store/files.ts';
import { CardIndex, type CardRow, type CardRowWithTags } from '../store/index/index.ts';
import { GitBackup } from '../store/backup.ts';
import { isValidIdFormat } from '../domain/id.ts';
import { embedFor } from './embed.ts';
import { renderMarkdown, renderPage, safeHref, type PageOptions } from './render.ts';
import { decorateThread, fmtDate, fmtTime, toItem } from './present.ts';
import {
  CARD_TYPES,
  DEFAULT_REL,
  PROVENANCES,
  REL_TYPES,
  REPLY_TYPES,
  type CardDraft,
  type CardLink,
  type CardType,
  type Rel,
} from '../domain/types.ts';
import {
  LOCKED_MESSAGE,
  W1_MESSAGE,
  computeW1,
  isWithinEditWindow,
  lockAt,
} from '../domain/rules.ts';
import { createCard, updateCard, type CardServiceDeps } from '../service/cards.ts';
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

/** 「逗號或空白分隔」的一行字串切成標籤。空白項在這一步就被丟掉。 */
function splitTags(line: string): string[] {
  return line
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function normalizeDraft(body: unknown): CardDraft {
  const b = (body ?? {}) as Record<string, unknown>;

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
    title: String(b.title ?? ''),
    body: String(b.body ?? ''),
    tags,
    url: b.url === undefined || b.url === null ? null : String(b.url),
    provenance: b.provenance === undefined || b.provenance === null ? null : String(b.provenance),
    links,
  };
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
  };

  const html = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).type('text/html; charset=utf-8').send(body);

  /** 每一頁的側欄都帶著最近的卡片，所以統一從這裡出去。 */
  const shell = (view: string, data: Record<string, unknown>, opts: PageOptions) =>
    renderPage(view, data, {
      ...opts,
      recent: lists.recent(index).map((r) => ({ id: r.id, title: r.title })),
    });

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
          items: rows.map(toItem),
          total,
          type,
          tag,
          types: CARD_TYPES,
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
    links: { rel: string; to: string; title?: string | null }[],
    opts: { replyTo?: string; errors?: string[]; source?: CardRowWithTags | null } = {},
  ) =>
    shell(
      'new',
      {
        values: {
          type: '',
          title: '',
          body: '',
          tags: '',
          url: '',
          provenance: '',
          ...values,
        },
        links,
        errors: opts.errors ?? [],
        replyTo: opts.replyTo ?? '',
        source: opts.source
          ? {
              id: opts.source.id,
              type: opts.source.type,
              title: opts.source.title,
              tags: opts.source.tags,
              date: fmtDate(opts.source.created),
              body_html: renderMarkdown(opts.source.body),
              provenance: opts.source.provenance === 'default' ? null : opts.source.provenance,
            }
          : null,
        types: opts.replyTo ? REPLY_TYPES : CARD_TYPES,
        rels: REL_TYPES,
        provenances: PROVENANCES,
      },
      { title: 'new', fab: false },
    );

  app.get('/new', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const target = q.to && isValidIdFormat(q.to) ? index.getCard(q.to) : null;
    const allowed = target ? (REPLY_TYPES as readonly string[]) : (CARD_TYPES as readonly string[]);
    const type = q.type && allowed.includes(q.type) ? q.type : '';
    const links = target ? [{ rel: DEFAULT_REL, to: target.id, title: target.title }] : [];

    return html(reply, newFormPage({ type }, links, { replyTo: target?.id, source: target }));
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
          draft.links.map((l) => ({ ...l, title: index.getCard(l.to)?.title ?? null })),
          { errors, source, replyTo: source?.id },
        ),
        400,
      );
    };

    const result = createCard(cards, draft);
    if (!result.ok) return reject(result.errors);

    const { id } = result.card;
    if (wantsJson(req)) {
      return reply.code(302).header('location', `/c/${id}`).send({ ok: true, id });
    }
    return reply.code(302).header('location', `/c/${id}`).send();
  });

  // ---- 檢視

  app.get('/c/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id)) return reply.callNotFound();
    const card = index.getCard(id);
    if (!card) return reply.callNotFound();

    const out = index.outLinks(id);
    const targetTypes = new Map(out.map((l) => [l.id, l.type]));
    const links: CardLink[] = out.map((l) => ({ rel: l.rel as Rel, to: l.id }));

    return html(
      reply,
      shell(
        'card',
        {
          card,
          created_display: fmtTime(card.created),
          revised_display: card.revised ? fmtTime(card.revised) : null,
          provenance: card.provenance === 'default' ? null : card.provenance,
          lock_at: isWithinEditWindow(card) ? lockAt(card) : '',
          url_href: safeHref(card.url),
          embed: embedFor(card.url),
          body_html: renderMarkdown(card.body),
          upstream: decorateThread(index.linkTree(id, 'out', THREAD_DEPTH), UPSTREAM_OPEN),
          downstream: decorateThread(index.linkTree(id, 'in', THREAD_DEPTH), DOWNSTREAM_OPEN),
          upstream_count: out.length,
          downstream_count: index.backLinks(id).length,
          w1: computeW1(links, (t) => targetTypes.get(t) ?? null),
          w1_message: W1_MESSAGE,
          editable: isWithinEditWindow(card),
        },
        { title: card.title, fab: { to: id }, activeId: id },
      ),
    );
  });

  // ---- 五分鐘時窗內的修改

  app.get('/c/:id/edit', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidIdFormat(id) || !cardExists(config.corpusPath, id)) return reply.callNotFound();
    const card = readCard(config.corpusPath, id);
    if (!isWithinEditWindow(card)) {
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
          created_display: fmtTime(card.created),
          lock_at: lockAt(card),
          tags_line: card.tags.join(', '),
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
    });

    if (!result.ok) {
      return reply.code(result.reason === 'locked' ? 403 : 400).send({
        ok: false,
        errors: result.errors,
      });
    }
    return reply.send({ ok: true, id, revised: result.card.revised });
  });

  // ---- 標籤、孤兒、搜尋

  app.get('/tags', async (_req, reply) =>
    html(reply, shell('tags', { tags: lists.tagCounts(index) }, { title: 'tags', nav: 'tags' })),
  );

  app.get('/orphans', async (_req, reply) =>
    html(
      reply,
      shell(
        'orphans',
        { items: lists.orphans(index).map(toItem) },
        { title: 'orphans', nav: 'orphans' },
      ),
    ),
  );

  app.get('/search', async (req, reply) => {
    const q = String((req.query as Record<string, unknown>).q ?? '').trim();
    const items = lists.search(index, q).map(toItem);
    return html(reply, shell('search', { q, items }, { title: 'search', q, nav: 'search' }));
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
