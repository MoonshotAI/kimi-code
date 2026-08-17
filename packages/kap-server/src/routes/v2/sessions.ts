/**
 * `/api/v2/sessions` — domain-grouped session list query.
 *
 * The v2 surface shares v1's wire conventions:
 *   - every response is wrapped in the `{ code, msg, data, request_id }`
 *     envelope and the business outcome lives in `code` — `0` success,
 *     `40001` for invalid query params (zod issues ride the `details` list),
 *     `40922` for a page_token that no longer matches the query conditions;
 *   - the HTTP status only reports server-/transport-level outcomes — the
 *     global bearer-auth hook answers 401 before routing, and unhandled
 *     exceptions land in the catch-all error hook as `50001`;
 *   - pagination is an opaque cursor (`page_token`, base64url JSON with a
 *     version + query fingerprint + keyset position, following the search
 *     module's token precedent) that binds every query condition of the
 *     first page — flipping any condition mid-pagination fails with 40922
 *     instead of silently serving a drifted window;
 *   - alternatively, `page` (1-based) switches to stateless page-number
 *     mode for admin-style lists that jump arbitrarily: each request is a
 *     full independent snapshot (re-drained, re-filtered, re-sorted — the
 *     same per-request semantics the cursor mode already has), no token is
 *     minted, and none is accepted (`page` + `page_token` together is a
 *     40001). Jumping to page N needs no token binding, so the 40922
 *     fingerprint mechanism does not apply. Every response carries `total`
 *     — the filtered/sorted set size — in both modes.
 *
 * Response domains: `workspace` / `meta` / `activity` are always projected;
 * `git` is opt-in (`include=git`), resolved per unique `workspace.cwd` with
 * a 60s server-side cache on top of `IGitService` — git/gh unavailable,
 * timeouts, and non-git directories all degrade to null fields (cached
 * too), never to request failures.
 *
 * Sorting / filtering: the session index only serves `updatedAt desc,
 * id desc` keyset pages, so the two other sorts and the status /
 * updated_after / updated_before / archived-only filters are applied at
 * the edge after draining the (workspace-, archive-) filtered set — the
 * same edge pattern as v1's unpaged `GET /api/v1/sessions`. All sorts
 * share one comparator + one cursor encoding, so every sort paginates
 * identically.
 *
 * Batch actions: `POST /sessions:archive` / `POST /sessions:restore`
 * (registered as `/sessions::{action}` — find-my-way splits a segment at
 * its first `:`, so the wire path carries a single colon, same as the v1
 * `/fs::browse` precedent) take `{ ids }` (non-empty, ≤5000 unique) and
 * answer per-item results — `data.results[]` in input order with
 * `ok` / `error`, plus `succeeded` / `failed` counts; only a body
 * validation failure fails the whole request. A live session goes
 * through the full `ISessionLifecycleService` chain (agents drain, scope
 * teardown, mirror drain); a cold session is never materialized — its
 * archived flag is patched straight into the persisted metadata
 * document, mirrored into the read model, and (`:archive` only)
 * announced through the same `event.session.archived` bus event the live
 * lifecycle publishes, while `:restore` publishes nothing, matching the
 * live restore. An unknown id folds into its own item as 40401. The
 * batch ends with one shared `ISessionIndexMirror.drain()`, never one
 * per item.
 */

import { createHash } from 'node:crypto';

import {
  ISessionIndex,
  ISessionIndexMirror,
  IWorkspaceAliases,
  IWorkspaceService,
  setSessionArchivedBatch,
  type Scope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { IGitService, type FsPullRequest } from '@moonshot-ai/agent-core-v2/app/git/git';
import { z } from 'zod';

import { defineRoute } from '../../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { resolveSessionFacts, type SessionFacts } from '../sessions';

interface V2SessionsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// ---------------------------------------------------------------------------
// Query contract
// ---------------------------------------------------------------------------

export const v2ActivityStatusSchema = z.enum([
  'running',
  'approval',
  'question',
  'failed',
  'idle',
]);
export type V2ActivityStatus = z.infer<typeof v2ActivityStatusSchema>;

const v2SortSchema = z.enum([
  'meta.updated_at_desc',
  'meta.updated_at_asc',
  'meta.created_at_desc',
]);
type V2Sort = z.infer<typeof v2SortSchema>;

const DEFAULT_PAGE_SIZE = 50;

/** Repeated query params arrive as arrays, single ones as scalars — accept both. */
const repeatedParam = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1)]).optional();

const KNOWN_INCLUDE_DOMAINS = new Set(['git']);

/** `include` — comma-separated opt-in expensive domains. */
function includeDomains(include: string | undefined): string[] {
  return (include ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** The one supported item projection: `fields=id,archived` (any order) — a
 *  lightweight ids-only shape for select-all-matching flows; only that form
 *  gets the relaxed page_size ceiling. */
const KNOWN_FIELDS = new Set(['id', 'archived']);
const IDS_PROJECTION_PAGE_SIZE_MAX = 10000;
const FULL_PAGE_SIZE_MAX = 100;

function parseFields(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function isIdsProjection(fields: readonly string[]): boolean {
  return fields.length === 2 && fields.every((field) => KNOWN_FIELDS.has(field));
}

const v2SessionsListQuerySchema = z
  .object({
    'workspace.id': repeatedParam(z.string().min(1)),
    'activity.status': repeatedParam(v2ActivityStatusSchema),
    'meta.updated_after': z.coerce.number().int().nonnegative().optional(),
    'meta.updated_before': z.coerce.number().int().nonnegative().optional(),
    'meta.archived': z.enum(['true', 'false', 'all']).optional(),
    sort: v2SortSchema.optional(),
    include: z.string().optional(),
    fields: z.string().optional(),
    page_size: z.coerce.number().int().min(1).max(IDS_PROJECTION_PAGE_SIZE_MAX).optional(),
    page: z.coerce.number().int().min(1).optional(),
    page_token: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    // Page-number mode is stateless — a token would be meaningless beside it.
    if (value.page !== undefined && value.page_token !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'page and page_token are mutually exclusive',
        path: ['page'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    // Unknown include domains are rejected so a typo never silently drops
    // paid-for data.
    for (const domain of includeDomains(value.include)) {
      if (!KNOWN_INCLUDE_DOMAINS.has(domain)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown domain '${domain}'`,
          path: ['include'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
    const fields = parseFields(value.fields);
    for (const field of fields) {
      if (!KNOWN_FIELDS.has(field)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown field '${field}'`,
          path: ['fields'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
    const projection = fields.length > 0 && fields.every((field) => KNOWN_FIELDS.has(field));
    if (projection && !isIdsProjection(fields)) {
      ctx.addIssue({
        code: 'custom',
        message: "unsupported fields projection; the only supported value is 'id,archived'",
        path: ['fields'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (projection && includeDomains(value.include).includes('git')) {
      ctx.addIssue({
        code: 'custom',
        message: 'include=git is not available with the ids projection',
        path: ['include'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    // The 100-item ceiling guards the full summary shape; the ids projection
    // is deliberately cheap, so it alone may page much larger.
    const pageSizeMax = projection ? IDS_PROJECTION_PAGE_SIZE_MAX : FULL_PAGE_SIZE_MAX;
    if (value.page_size !== undefined && value.page_size > pageSizeMax) {
      ctx.addIssue({
        code: 'custom',
        message: projection
          ? `page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
          : `page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
        path: ['page_size'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

/** Fastify delivers a repeated param as an array and a single one as a scalar. */
function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

interface NormalizedQuery {
  readonly workspaceFilter?: readonly string[];
  readonly statuses?: readonly V2ActivityStatus[];
  readonly updatedAfter?: number;
  readonly updatedBefore?: number;
  readonly archived: 'true' | 'false' | 'all';
  readonly sort: V2Sort;
  readonly includeGit: boolean;
  readonly pageSize: number;
  /** True when the ids projection (`fields=id,archived`) trims each item to
   *  the lightweight select-all shape. */
  readonly projection: boolean;
}

// ---------------------------------------------------------------------------
// Response contract (OpenAPI documentation; serialization is pass-through)
// ---------------------------------------------------------------------------

const v2GitDomainSchema = z.object({
  branch: z.string().nullable(),
  pull_request: z
    .object({
      number: z.number().int(),
      state: z.enum(['open', 'closed', 'merged']),
      url: z.string(),
    })
    .nullable(),
});

const v2SessionSchema = z.object({
  id: z.string(),
  workspace: z.object({ id: z.string(), cwd: z.string().nullable() }),
  meta: z.object({
    title: z.string().nullable(),
    last_prompt: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    archived: z.boolean(),
    /** Unix ms; null when absent (never archived, or archived before the
     *  field existed — clients fall back to updated_at for display). */
    archived_at: z.number().int().nullable(),
  }),
  activity: z.object({ status: v2ActivityStatusSchema }),
  git: v2GitDomainSchema.optional(),
});

const v2SessionIdProjectionSchema = z.object({
  id: z.string(),
  archived: z.boolean(),
});

const v2SessionPageSchema = z.object({
  /** Full summaries, or `{id, archived}` pairs under `fields=id,archived`. */
  items: z.array(z.union([v2SessionSchema, v2SessionIdProjectionSchema])),
  /** Filtered/sorted set size — present in both pagination modes. */
  total: z.number().int(),
  has_more: z.boolean(),
  next_page_token: z.string().nullable(),
});

/** `40001 validation.failed` carries the offending fields (REST.md §1.4). */
const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// ---------------------------------------------------------------------------
// Batch archive / restore contract
// ---------------------------------------------------------------------------

/** Cap on unique ids per batch, keeping one request's edge work bounded. */
const BATCH_IDS_MAX = 5000;

const v2SessionsBatchBodySchema = z
  .object({ ids: z.array(z.string().min(1)).min(1) })
  .superRefine((value, ctx) => {
    if (new Set(value.ids).size > BATCH_IDS_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `ids must contain at most ${BATCH_IDS_MAX} unique entries`,
        path: ['ids'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const v2SessionsBatchResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      error: z.object({ code: z.number().int(), message: z.string() }).optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});

type V2BatchItemResult = z.infer<typeof v2SessionsBatchResultSchema>['results'][number];

type V2GitDomain = z.infer<typeof v2GitDomainSchema>;
type V2SessionWire = z.infer<typeof v2SessionSchema>;
type V2SessionIdProjection = z.infer<typeof v2SessionIdProjectionSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A page_token that is corrupted, version-incompatible, or bound to other query conditions. */
class PageTokenMismatchError extends Error {}

// ---------------------------------------------------------------------------
// Activity status
// ---------------------------------------------------------------------------

/**
 * Map the core activity facts onto the v2 status enum. A pending interaction
 * outranks an active turn (the turn is parked waiting on it). `failed` is
 * observable live, and for cold sessions from the persisted outcome
 * (completed/cancelled stay `idle`, matching the live fold).
 */
export function mapActivityStatus(
  facts: SessionFacts,
  persistedLastTurnReason?: 'completed' | 'cancelled' | 'failed',
): V2ActivityStatus {
  if (facts.pendingInteraction === 'approval') return 'approval';
  if (facts.pendingInteraction === 'question') return 'question';
  if (facts.busy || facts.mainTurnActive) return 'running';
  if (facts.lastTurnReason === 'failed') return 'failed';
  if (facts.live === false && persistedLastTurnReason === 'failed') return 'failed';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Sorting + opaque page tokens
// ---------------------------------------------------------------------------

function sortKeyOf(sort: V2Sort): (summary: SessionSummary) => number {
  return sort === 'meta.created_at_desc'
    ? (summary) => summary.createdAt
    : (summary) => summary.updatedAt;
}

function makeComparator(sort: V2Sort): (a: SessionSummary, b: SessionSummary) => number {
  const keyOf = sortKeyOf(sort);
  const ascending = sort === 'meta.updated_at_asc';
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ascending ? ka - kb : kb - ka;
    const order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ascending ? order : -order;
  };
}

const PAGE_TOKEN_VERSION = 1;

/**
 * Fingerprint over every normalized query condition (raw filter values, so
 * equivalent-but-differently-spelled first pages simply mint different
 * tokens). Mirrors the search module's sha256/base64url/16-char precedent.
 */
function queryFingerprint(query: NormalizedQuery): string {
  const canonical = [
    query.workspaceFilter === undefined ? null : [...query.workspaceFilter].toSorted(),
    query.statuses === undefined ? null : [...query.statuses].toSorted(),
    query.updatedAfter ?? null,
    query.updatedBefore ?? null,
    query.archived,
    query.sort,
    query.includeGit,
    query.pageSize,
    // The projection changes the item shape — a token minted across that
    // boundary would silently flip shapes mid-pagination.
    query.projection,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 16);
}

function encodePageToken(fingerprint: string, key: number, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: PAGE_TOKEN_VERSION, f: fingerprint, k: [key, id] }),
  ).toString('base64url');
}

/** Decode + validate a page token; any failure is a 40922 mismatch by contract. */
function decodePageToken(raw: string, fingerprint: string): readonly [number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageTokenMismatchError(
      'page_token is corrupted; discard it and restart from the first page',
    );
  }
  const token = parsed as { v?: unknown; f?: unknown; k?: unknown };
  const key = Array.isArray(token.k) ? token.k : undefined;
  if (
    token.v !== PAGE_TOKEN_VERSION ||
    typeof token.f !== 'string' ||
    key === undefined ||
    key.length !== 2 ||
    typeof key[0] !== 'number' ||
    typeof key[1] !== 'string'
  ) {
    throw new PageTokenMismatchError(
      'page_token is malformed or from an incompatible version; discard it and restart from the first page',
    );
  }
  if (token.f !== fingerprint) {
    throw new PageTokenMismatchError(
      'page_token does not match the query conditions; discard it and restart from the first page',
    );
  }
  return [key[0], key[1]];
}

// ---------------------------------------------------------------------------
// git domain
// ---------------------------------------------------------------------------

const GIT_DOMAIN_TTL_MS = 60_000;

const GIT_DOMAIN_UNAVAILABLE: V2GitDomain = { branch: null, pull_request: null };

/** The v2 enum has no `draft`; a draft PR is still an open PR. */
function mapPullRequest(pr: FsPullRequest | null): V2GitDomain['pull_request'] {
  if (pr === null) return null;
  return { number: pr.number, state: pr.state === 'draft' ? 'open' : pr.state, url: pr.url };
}

/**
 * Per-cwd git domain resolver with a 60s TTL cache (the spec's dedup +
 * caching contract). Backed by the App-scope `IGitService` (which adds its
 * own 60s PR cache); failures degrade to null fields and are cached too, so
 * a broken cwd never costs a subprocess per request.
 */
class GitDomainResolver {
  private readonly cache = new Map<string, { value: V2GitDomain; fetchedAt: number }>();

  constructor(private readonly core: Scope) {}

  async resolveAll(cwds: ReadonlySet<string>): Promise<ReadonlyMap<string, V2GitDomain>> {
    const now = Date.now();
    const resolved = new Map<string, V2GitDomain>();
    const misses: string[] = [];
    for (const cwd of cwds) {
      const hit = this.cache.get(cwd);
      if (hit !== undefined && now - hit.fetchedAt < GIT_DOMAIN_TTL_MS) {
        resolved.set(cwd, hit.value);
      } else {
        misses.push(cwd);
      }
    }
    await Promise.all(
      misses.map(async (cwd) => {
        const value = await this.fetch(cwd);
        this.cache.set(cwd, { value, fetchedAt: now });
        resolved.set(cwd, value);
      }),
    );
    return resolved;
  }

  private async fetch(cwd: string): Promise<V2GitDomain> {
    try {
      const status = await this.core.accessor.get(IGitService).status(cwd);
      return {
        branch: status.branch.length === 0 ? null : status.branch,
        pull_request: mapPullRequest(status.pullRequest),
      };
    } catch {
      return GIT_DOMAIN_UNAVAILABLE;
    }
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Run one `:archive` / `:restore` batch: the domain package owns the
 * live/cold split (live through the full lifecycle chain, cold through the
 * direct patch); this adapter maps its per-item outcomes onto wire error
 * codes and ends with a single shared mirror drain.
 */
async function runBatchArchive(
  core: Scope,
  action: 'archive' | 'restore',
  rawIds: readonly string[],
  requestId: string,
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const archived = action === 'archive';
  const ids = [...new Set(rawIds)];
  const outcomes = await setSessionArchivedBatch(core.accessor, ids, archived);
  const results: V2BatchItemResult[] = outcomes.map((outcome) =>
    outcome.ok
      ? { id: outcome.id, ok: true }
      : {
          id: outcome.id,
          ok: false,
          error:
            outcome.reason === 'not_found'
              ? { code: ErrorCode.SESSION_NOT_FOUND, message: outcome.message }
              : { code: ErrorCode.INTERNAL_ERROR, message: outcome.message },
        },
  );
  // One drain for the whole batch — cold records queue in the mirror, and
  // the hot path already drained itself per call.
  await core.accessor.get(ISessionIndexMirror).drain();

  const succeeded = results.filter((result) => result.ok).length;
  reply.send(
    okEnvelope({ results, succeeded, failed: results.length - succeeded }, requestId),
  );
}

export function registerV2SessionsRoutes(app: V2SessionsRouteHost, core: Scope): void {
  const gitResolver = new GitDomainResolver(core);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: v2SessionsListQuerySchema,
      success: { data: v2SessionPageSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
      },
      description:
        "List sessions with domain-grouped metadata (workspace / meta / activity; git via include=git). Paginate with the opaque page_token (binds the first page’s query conditions) or with the stateless 1-based page parameter; every page carries total. fields=id,archived trims each item to the lightweight ids projection (select-all-matching flows; page_size ceiling relaxed to 10000).",
      tags: ['v2-sessions'],
    },
    async (req, reply) => {
      const raw = req.query;

      const query: NormalizedQuery = {
        workspaceFilter: asArray(raw['workspace.id']),
        statuses: asArray(raw['activity.status']),
        updatedAfter: raw['meta.updated_after'],
        updatedBefore: raw['meta.updated_before'],
        archived: raw['meta.archived'] ?? 'false',
        sort: raw.sort ?? 'meta.updated_at_desc',
        includeGit: includeDomains(raw.include).includes('git'),
        pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
        projection: parseFields(raw.fields).length > 0,
      };

      const fingerprint = queryFingerprint(query);
      let cursor: readonly [number, string] | undefined;
      if (raw.page_token !== undefined) {
        try {
          cursor = decodePageToken(raw.page_token, fingerprint);
        } catch (error) {
          if (error instanceof PageTokenMismatchError) {
            reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, error.message, req.id));
            return;
          }
          throw error;
        }
      }

      // Workspace filter: each requested id expands to its full alias set
      // (legacy split buckets list as one workspace); unknown ids resolve
      // to themselves and simply match nothing.
      let workspaceIds: string[] | undefined;
      if (query.workspaceFilter !== undefined) {
        const aliases = core.accessor.get(IWorkspaceAliases);
        const sets = await Promise.all(
          query.workspaceFilter.map((id) => aliases.resolveAliasIds(id)),
        );
        workspaceIds = [...new Set(sets.flat())];
      }

      const page = await core.accessor.get(ISessionIndex).listRecent({
        workspaceIds,
        includeArchived: query.archived !== 'false',
      });

      // Live activity facts are read at most once per session; a cold
      // session resolves to the non-busy defaults (→ `idle`).
      const factsById = new Map<string, SessionFacts>();
      const factsOf = (id: string): SessionFacts => {
        let facts = factsById.get(id);
        if (facts === undefined) {
          facts = resolveSessionFacts(core, id);
          factsById.set(id, facts);
        }
        return facts;
      };

      const filtered = page.items.filter((summary) => {
        if (query.archived === 'true' && !summary.archived) return false;
        if (query.updatedAfter !== undefined && summary.updatedAt < query.updatedAfter) {
          return false;
        }
        if (query.updatedBefore !== undefined && summary.updatedAt > query.updatedBefore) {
          return false;
        }
        if (
          query.statuses !== undefined &&
          !query.statuses.includes(mapActivityStatus(factsOf(summary.id), summary.lastTurnReason))
        ) {
          return false;
        }
        return true;
      });

      const comparator = makeComparator(query.sort);
      const sorted = filtered.toSorted(comparator);

      let start = 0;
      if (raw.page !== undefined) {
        // Stateless page-number mode: slice the fresh snapshot directly;
        // no token is minted below and none was accepted above.
        start = (raw.page - 1) * query.pageSize;
      } else if (cursor !== undefined) {
        const [cursorKey, cursorId] = cursor;
        // The comparator only reads the sort key + id, so a synthetic
        // cursor item pins the keyset position in any sort order.
        const cursorItem = {
          id: cursorId,
          updatedAt: cursorKey,
          createdAt: cursorKey,
        } as SessionSummary;
        start = sorted.findIndex((item) => comparator(item, cursorItem) > 0);
        if (start === -1) start = sorted.length;
      }

      const window = sorted.slice(start, start + query.pageSize);
      const hasMore = start + query.pageSize < sorted.length;
      const lastServed = window.at(-1);
      const nextPageToken =
        raw.page === undefined && hasMore && lastServed !== undefined
          ? encodePageToken(fingerprint, sortKeyOf(query.sort)(lastServed), lastServed.id)
          : null;

      // Ids projection: trim each item to {id, archived} — no workspace-root
      // back-fill, no git domain, no per-session live lookups beyond whatever
      // the activity filter already resolved.
      if (query.projection) {
        const projected: V2SessionIdProjection[] = window.map((summary) => ({
          id: summary.id,
          archived: summary.archived,
        }));
        reply.send(
          okEnvelope(
            {
              items: projected,
              total: sorted.length,
              has_more: hasMore,
              next_page_token: nextPageToken,
            },
            req.id,
          ),
        );
        return;
      }

      // cwd: the session's own frozen value wins; the registry back-fills
      // sessions persisted before cwd was stored; unrecoverable → null.
      const roots = new Map(
        (await core.accessor.get(IWorkspaceService).list()).map(
          (workspace) => [workspace.id, workspace.root] as const,
        ),
      );
      const cwdOf = (summary: SessionSummary): string | null =>
        summary.cwd ?? roots.get(summary.workspaceId) ?? null;

      let gitByCwd: ReadonlyMap<string, V2GitDomain> | undefined;
      if (query.includeGit) {
        const cwds = new Set<string>();
        for (const summary of window) {
          const cwd = cwdOf(summary);
          if (cwd !== null) cwds.add(cwd);
        }
        gitByCwd = await gitResolver.resolveAll(cwds);
      }

      const items: V2SessionWire[] = window.map((summary) => {
        const cwd = cwdOf(summary);
        return {
          id: summary.id,
          workspace: { id: summary.workspaceId, cwd },
          meta: {
            title: summary.title ?? null,
            last_prompt: summary.lastPrompt ?? null,
            created_at: summary.createdAt,
            updated_at: summary.updatedAt,
            archived: summary.archived,
            archived_at: summary.archivedAt ?? null,
          },
          activity: { status: mapActivityStatus(factsOf(summary.id), summary.lastTurnReason) },
          git:
            gitByCwd === undefined
              ? undefined
              : ((cwd !== null ? gitByCwd.get(cwd) : undefined) ?? GIT_DOMAIN_UNAVAILABLE),
        };
      });

      reply.send(
        okEnvelope(
          { items, total: sorted.length, has_more: hasMore, next_page_token: nextPageToken },
          req.id,
        ),
      );
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<V2SessionsRouteHost['get']>[2],
  );

  for (const action of ['archive', 'restore'] as const) {
    const batchRoute = defineRoute(
      {
        method: 'POST',
        // `/sessions::${action}` in find-my-way serves the wire path
        // `/sessions:archive` / `/sessions:restore` (single colon).
        path: `/sessions::${action}`,
        body: v2SessionsBatchBodySchema,
        success: { data: v2SessionsBatchResultSchema },
        errors: {
          [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        },
        description: `Batch-${action} sessions by id ({ ids }, ≤5000 unique). Per-item results — a missing session folds into its own item; cold sessions are patched without materialization.`,
        tags: ['v2-sessions'],
      },
      async (req, reply) => {
        await runBatchArchive(core, action, req.body.ids, req.id, reply);
      },
    );
    app.post(
      batchRoute.path,
      batchRoute.options,
      batchRoute.handler as Parameters<V2SessionsRouteHost['post']>[2],
    );
  }
}
