
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

const v2ViewSchema = z.enum(['flat', 'by_workspace']);
type V2View = z.infer<typeof v2ViewSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_GROUP_PAGE_SIZE = 5;

const repeatedParam = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1)]).optional();

const KNOWN_INCLUDE_DOMAINS = new Set(['git']);

function includeDomains(include: string | undefined): string[] {
  return (include ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

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
    'meta.has_prompt': z.enum(['true', 'false']).optional(),
    view: v2ViewSchema.optional(),
    'group.page_size': z.coerce.number().int().min(1).max(IDS_PROJECTION_PAGE_SIZE_MAX).optional(),
    sort: v2SortSchema.optional(),
    include: z.string().optional(),
    fields: z.string().optional(),
    page_size: z.coerce.number().int().min(1).max(IDS_PROJECTION_PAGE_SIZE_MAX).optional(),
    page: z.coerce.number().int().min(1).optional(),
    page_token: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.page !== undefined && value.page_token !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'page and page_token are mutually exclusive',
        path: ['page'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
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
    if (value['group.page_size'] !== undefined) {
      if (value.view !== 'by_workspace') {
        ctx.addIssue({
          code: 'custom',
          message: "group.page_size requires view='by_workspace'",
          path: ['group.page_size'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      } else if (value['group.page_size'] > pageSizeMax) {
        ctx.addIssue({
          code: 'custom',
          message: projection
            ? `group.page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
            : `group.page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
          path: ['group.page_size'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
  });

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
  readonly hasPrompt?: boolean;
  readonly view: V2View;
  readonly groupPageSize: number;
  readonly sort: V2Sort;
  readonly includeGit: boolean;
  readonly pageSize: number;
  readonly projection: boolean;
}

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
  items: z.array(z.union([v2SessionSchema, v2SessionIdProjectionSchema])),
  total: z.number().int(),
  has_more: z.boolean(),
  next_page_token: z.string().nullable(),
});

const v2SessionGroupSchema = z.object({
  workspace: z.object({ id: z.string(), cwd: z.string().nullable() }),
  sessions: z.array(z.union([v2SessionSchema, v2SessionIdProjectionSchema])),
  total: z.number().int(),
});

const v2SessionGroupPageSchema = z.object({
  groups: z.array(v2SessionGroupSchema),
  total: z.number().int(),
  has_more: z.boolean(),
  next_page_token: z.string().nullable(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));


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

class PageTokenMismatchError extends Error {}

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

function queryFingerprint(query: NormalizedQuery): string {
  const canonical = [
    query.workspaceFilter === undefined ? null : [...query.workspaceFilter].toSorted(),
    query.statuses === undefined ? null : [...query.statuses].toSorted(),
    query.updatedAfter ?? null,
    query.updatedBefore ?? null,
    query.archived,
    query.hasPrompt ?? null,
    query.view,
    query.groupPageSize,
    query.sort,
    query.includeGit,
    query.pageSize,
    query.projection,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, 16);
}

function encodePageToken(fingerprint: string, key: number, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: PAGE_TOKEN_VERSION, f: fingerprint, k: [key, id] }),
  ).toString('base64url');
}

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

const GIT_DOMAIN_TTL_MS = 60_000;

const GIT_DOMAIN_UNAVAILABLE: V2GitDomain = { branch: null, pull_request: null };

function mapPullRequest(pr: FsPullRequest | null): V2GitDomain['pull_request'] {
  if (pr === null) return null;
  return { number: pr.number, state: pr.state === 'draft' ? 'open' : pr.state, url: pr.url };
}

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
      success: { data: z.union([v2SessionPageSchema, v2SessionGroupPageSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
      },
      description:
        "List sessions with domain-grouped metadata (workspace / meta / activity; git via include=git). Paginate with the opaque page_token (binds the first page’s query conditions) or with the stateless 1-based page parameter; every page carries total. fields=id,archived trims each item to the lightweight ids projection (select-all-matching flows; page_size ceiling relaxed to 10000). meta.has_prompt=true|false filters sessions by whether they carry a prompt. view=by_workspace groups the matching set per workspace — each group carries that workspace's first group.page_size sessions (default 5) under the requested sort plus the group's full matching total; page/page_token then page over groups.",
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
        hasPrompt:
          raw['meta.has_prompt'] === undefined ? undefined : raw['meta.has_prompt'] === 'true',
        view: raw.view ?? 'flat',
        groupPageSize: raw['group.page_size'] ?? DEFAULT_GROUP_PAGE_SIZE,
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
        if (
          query.hasPrompt !== undefined &&
          ((summary.lastPrompt ?? '').length > 0) !== query.hasPrompt
        ) {
          return false;
        }
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
      const keyOf = sortKeyOf(query.sort);
      const ascending = query.sort === 'meta.updated_at_asc';

      const loadCwdOf = async (): Promise<(summary: SessionSummary) => string | null> => {
        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map(
            (workspace) => [workspace.id, workspace.root] as const,
          ),
        );
        return (summary) => summary.cwd ?? roots.get(summary.workspaceId) ?? null;
      };

      const buildItems = async (
        summaries: readonly SessionSummary[],
        cwdOf: (summary: SessionSummary) => string | null,
      ): Promise<V2SessionWire[]> => {
        let gitByCwd: ReadonlyMap<string, V2GitDomain> | undefined;
        if (query.includeGit) {
          const cwds = new Set<string>();
          for (const summary of summaries) {
            const cwd = cwdOf(summary);
            if (cwd !== null) cwds.add(cwd);
          }
          gitByCwd = await gitResolver.resolveAll(cwds);
        }
        return summaries.map((summary) => {
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
      };

      const projectIds = (summaries: readonly SessionSummary[]): V2SessionIdProjection[] =>
        summaries.map((summary) => ({ id: summary.id, archived: summary.archived }));

      if (query.view === 'by_workspace') {
        interface SessionGroup {
          readonly workspaceId: string;
          readonly rep: SessionSummary;
          readonly items: SessionSummary[];
        }
        const aliasService = core.accessor.get(IWorkspaceAliases);
        const canonicalById = new Map<string, string>();
        const canonicalIdOf = async (workspaceId: string): Promise<string> => {
          let canonical = canonicalById.get(workspaceId);
          if (canonical === undefined) {
            const set = await aliasService.resolveAliasIds(workspaceId);
            canonical = set.length === 0 ? workspaceId : set.toSorted()[0] as string;
            for (const id of set) canonicalById.set(id, canonical);
          }
          return canonical;
        };
        const byWorkspace = new Map<string, SessionGroup>();
        for (const summary of sorted) {
          const groupId = await canonicalIdOf(summary.workspaceId);
          const group = byWorkspace.get(groupId);
          if (group === undefined) {
            byWorkspace.set(groupId, {
              workspaceId: groupId,
              rep: summary,
              items: [summary],
            });
          } else {
            group.items.push(summary);
          }
        }
        const groupList = [...byWorkspace.values()];
        const groupComparator = (a: SessionGroup, b: SessionGroup): number => {
          const ka = keyOf(a.rep);
          const kb = keyOf(b.rep);
          if (ka !== kb) return ascending ? ka - kb : kb - ka;
          return a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0;
        };
        groupList.sort(groupComparator);

        let start = 0;
        if (raw.page !== undefined) {
          start = (raw.page - 1) * query.pageSize;
        } else if (cursor !== undefined) {
          const [cursorKey, cursorId] = cursor;
          const cursorGroup: SessionGroup = {
            workspaceId: cursorId,
            rep: { id: cursorId, updatedAt: cursorKey, createdAt: cursorKey } as SessionSummary,
            items: [],
          };
          start = groupList.findIndex((group) => groupComparator(group, cursorGroup) > 0);
          if (start === -1) start = groupList.length;
        }

        const windowGroups = groupList.slice(start, start + query.pageSize);
        const hasMore = start + query.pageSize < groupList.length;
        const lastGroup = windowGroups.at(-1);
        const nextPageToken =
          raw.page === undefined && hasMore && lastGroup !== undefined
            ? encodePageToken(fingerprint, keyOf(lastGroup.rep), lastGroup.workspaceId)
            : null;

        const cwdOf = await loadCwdOf();
        const groups = await Promise.all(
          windowGroups.map(async (group) => {
            const served = group.items.slice(0, query.groupPageSize);
            return {
              workspace: { id: group.workspaceId, cwd: cwdOf(group.rep) },
              sessions: query.projection
                ? projectIds(served)
                : await buildItems(served, cwdOf),
              total: group.items.length,
            };
          }),
        );

        reply.send(
          okEnvelope(
            { groups, total: groupList.length, has_more: hasMore, next_page_token: nextPageToken },
            req.id,
          ),
        );
        return;
      }

      let start = 0;
      if (raw.page !== undefined) {
        start = (raw.page - 1) * query.pageSize;
      } else if (cursor !== undefined) {
        const [cursorKey, cursorId] = cursor;
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
          ? encodePageToken(fingerprint, keyOf(lastServed), lastServed.id)
          : null;

      if (query.projection) {
        reply.send(
          okEnvelope(
            {
              items: projectIds(window),
              total: sorted.length,
              has_more: hasMore,
              next_page_token: nextPageToken,
            },
            req.id,
          ),
        );
        return;
      }

      const items = await buildItems(window, await loadCwdOf());

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
