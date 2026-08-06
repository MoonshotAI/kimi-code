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
 *     instead of silently serving a drifted window.
 *
 * Response domains: `workspace` / `meta` / `activity` are always projected;
 * `git` is opt-in (`include=git`), resolved per unique `workspace.cwd` with
 * a 60s server-side cache on top of `IGitService` — git/gh unavailable,
 * timeouts, and non-git directories all degrade to null fields (cached
 * too), never to request failures.
 *
 * Sorting / filtering: the session index only serves `updatedAt desc,
 * id desc` keyset pages, so the two other sorts and the status /
 * updated_after / archived-only filters are applied at the edge after
 * draining the (workspace-, archive-) filtered set — the same edge pattern
 * as v1's unpaged `GET /api/v1/sessions`. All sorts share one comparator +
 * one cursor encoding, so every sort paginates identically.
 */

import { createHash } from 'node:crypto';

import {
  ISessionIndex,
  IWorkspaceAliases,
  IWorkspaceService,
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

const v2SessionsListQuerySchema = z
  .object({
    'workspace.id': repeatedParam(z.string().min(1)),
    'activity.status': repeatedParam(v2ActivityStatusSchema),
    'meta.updated_after': z.coerce.number().int().nonnegative().optional(),
    'meta.archived': z.enum(['true', 'false', 'all']).optional(),
    sort: v2SortSchema.optional(),
    include: z.string().optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    page_token: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
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
  readonly archived: 'true' | 'false' | 'all';
  readonly sort: V2Sort;
  readonly includeGit: boolean;
  readonly pageSize: number;
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
  }),
  activity: z.object({ status: v2ActivityStatusSchema }),
  git: v2GitDomainSchema.optional(),
});

const v2SessionPageSchema = z.object({
  items: z.array(v2SessionSchema),
  has_more: z.boolean(),
  next_page_token: z.string().nullable(),
});

/** `40001 validation.failed` carries the offending fields (REST.md §1.4). */
const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

type V2GitDomain = z.infer<typeof v2GitDomainSchema>;
type V2SessionWire = z.infer<typeof v2SessionSchema>;

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
    query.archived,
    query.sort,
    query.includeGit,
    query.pageSize,
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
        'List sessions with domain-grouped metadata (workspace / meta / activity; git via include=git). Opaque-cursor pagination: page_token binds the first page’s query conditions.',
      tags: ['v2-sessions'],
    },
    async (req, reply) => {
      const raw = req.query;

      const query: NormalizedQuery = {
        workspaceFilter: asArray(raw['workspace.id']),
        statuses: asArray(raw['activity.status']),
        updatedAfter: raw['meta.updated_after'],
        archived: raw['meta.archived'] ?? 'false',
        sort: raw.sort ?? 'meta.updated_at_desc',
        includeGit: includeDomains(raw.include).includes('git'),
        pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
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
      if (cursor !== undefined) {
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
        hasMore && lastServed !== undefined
          ? encodePageToken(fingerprint, sortKeyOf(query.sort)(lastServed), lastServed.id)
          : null;

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
          },
          activity: { status: mapActivityStatus(factsOf(summary.id), summary.lastTurnReason) },
          git:
            gitByCwd === undefined
              ? undefined
              : ((cwd !== null ? gitByCwd.get(cwd) : undefined) ?? GIT_DOMAIN_UNAVAILABLE),
        };
      });

      reply.send(okEnvelope({ items, has_more: hasMore, next_page_token: nextPageToken }, req.id));
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<V2SessionsRouteHost['get']>[2],
  );
}
