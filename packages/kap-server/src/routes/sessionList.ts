import { createHash } from 'node:crypto';

import {
  EnvironmentError,
  IEnvironmentService,
  ISessionIndex,
  ISessionIndexMirror,
  IWorkspaceAliases,
  environmentBindingId,
  LOCAL_ENVIRONMENT_ID,
  setSessionArchivedBatch,
  type Scope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { IGitService, type FsPullRequest } from '@moonshot-ai/agent-core-v2/app/git/git';
import { GitService } from '@moonshot-ai/agent-core-v2/app/git/gitService';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  batchSessionsRequestSchema,
  batchSessionsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  parseSessionFields,
  parseSessionIncludeDomains,
  type BatchSessionsResponse,
  type SessionIdProjection,
  type SessionsArchivedFilter,
  type SessionsSort,
  type SessionsView,
} from '../protocol/rest-session';
import type { Session, SessionActivity, SessionGit } from '../protocol/session';
import { loadWorkspaceVisibility } from '../services/workspaceVisibility';
import { withTimeout } from '../transport/errors';
import { resolveSessionFacts, toWireSession, type SessionFacts } from './sessions';

interface SessionListRouteHost {
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

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_GROUP_PAGE_SIZE = 5;
const GIT_DOMAIN_TTL_MS = 60_000;
const REMOTE_GIT_DOMAIN_TIMEOUT_MS = 3_000;
const GIT_DOMAIN_UNAVAILABLE: SessionGit = {};
const PAGE_TOKEN_VERSION = 1;

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

type BatchItemResult = BatchSessionsResponse['results'][number];

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

interface NormalizedQuery {
  readonly workspaceFilter?: readonly string[];
  readonly busy?: boolean;
  readonly activities?: readonly SessionActivity[];
  readonly updatedAfter?: number;
  readonly updatedBefore?: number;
  readonly archived: SessionsArchivedFilter;
  readonly hasPrompt?: boolean;
  readonly view: SessionsView;
  readonly groupPageSize: number;
  readonly sort: SessionsSort;
  readonly includeGit: boolean;
  readonly pageSize: number;
  readonly projection: boolean;
}

class PageTokenMismatchError extends Error {}

export function mapSessionActivity(facts: SessionFacts): SessionActivity {
  if (facts.mainTurnActive) return 'turn';
  if (facts.busy) return 'background';
  return 'idle';
}

function sortKeyOf(sort: SessionsSort): (summary: SessionSummary) => number {
  return sort === 'created_at_desc'
    ? (summary) => summary.createdAt
    : (summary) => summary.updatedAt;
}

function makeComparator(sort: SessionsSort): (a: SessionSummary, b: SessionSummary) => number {
  const keyOf = sortKeyOf(sort);
  const ascending = sort === 'updated_at_asc';
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ascending ? ka - kb : kb - ka;
    const order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ascending ? order : -order;
  };
}

function queryFingerprint(query: NormalizedQuery): string {
  const canonical = [
    query.workspaceFilter === undefined ? null : [...query.workspaceFilter].toSorted(),
    query.busy ?? null,
    query.activities === undefined ? null : [...query.activities].toSorted(),
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

function mapPullRequest(pr: FsPullRequest | null): SessionGit['pull_request'] {
  if (pr === null) return undefined;
  return { number: pr.number, state: pr.state === 'draft' ? 'open' : pr.state, url: pr.url };
}

interface GitTarget {
  readonly key: string;
  readonly environmentId: string;
  readonly cwd: string;
}

function gitTarget(summary: SessionSummary, workspaceCwd: string): GitTarget | undefined {
  const environmentId = summary.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const cwd = environmentId === LOCAL_ENVIRONMENT_ID ? workspaceCwd : summary.environmentCwd;
  if (cwd === undefined || cwd.length === 0) return undefined;
  return { key: environmentBindingId(environmentId, cwd), environmentId, cwd };
}

class GitDomainResolver {
  private readonly cache = new Map<string, { value: SessionGit; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<SessionGit | undefined>>();

  constructor(private readonly core: Scope) {}

  async resolveAll(
    summaries: readonly SessionSummary[],
    cwdOf: (summary: SessionSummary) => string,
  ): Promise<ReadonlyMap<string, SessionGit>> {
    const targets = summaries.flatMap((summary) => {
      const target = gitTarget(summary, cwdOf(summary));
      return target === undefined ? [] : [{ sessionId: summary.id, target }];
    });
    const now = Date.now();
    const resolvedByKey = new Map<string, SessionGit>();
    const misses = new Map<string, GitTarget>();
    for (const { target } of targets) {
      const hit = this.cache.get(target.key);
      if (hit !== undefined && now - hit.fetchedAt < GIT_DOMAIN_TTL_MS) {
        resolvedByKey.set(target.key, hit.value);
      } else {
        misses.set(target.key, target);
      }
    }
    await Promise.all(
      [...misses].map(async ([key, target]) => {
        const value = await this.load(key, target);
        if (value !== undefined) resolvedByKey.set(key, value);
      }),
    );
    return new Map(
      targets.map(({ sessionId, target }) => [
        sessionId,
        resolvedByKey.get(target.key) ?? GIT_DOMAIN_UNAVAILABLE,
      ]),
    );
  }

  private async load(key: string, target: GitTarget): Promise<SessionGit | undefined> {
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      const fetchedAt = Date.now();
      pending = this.fetch(target)
        .then((value) => {
          if (value !== undefined) this.cache.set(key, { value, fetchedAt });
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    if (target.environmentId === LOCAL_ENVIRONMENT_ID) return pending;
    return withTimeout(pending, REMOTE_GIT_DOMAIN_TIMEOUT_MS).catch(() => undefined);
  }

  private async fetch(target: GitTarget): Promise<SessionGit | undefined> {
    try {
      let status: Awaited<ReturnType<IGitService['status']>>;
      if (target.environmentId === LOCAL_ENVIRONMENT_ID) {
        status = await this.core.accessor.get(IGitService).status(target.cwd);
      } else {
        const environments = this.core.accessor.get(IEnvironmentService);
        const lease = environments.acquire({ environmentId: target.environmentId }, ['fs']);
        try {
          status = await new GitService(
            environments,
            lease.environment.fs!,
            target.environmentId,
          ).status(target.cwd);
        } finally {
          lease.dispose();
        }
      }
      return {
        branch: status.branch.length === 0 ? undefined : status.branch,
        pull_request: mapPullRequest(status.pullRequest),
      };
    } catch (error) {
      return error instanceof EnvironmentError ? undefined : GIT_DOMAIN_UNAVAILABLE;
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
  const results: BatchItemResult[] = outcomes.map((outcome) =>
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

export function registerSessionListAndBatchRoutes(
  app: SessionListRouteHost,
  core: Scope,
): void {
  const gitResolver = new GitDomainResolver(core);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: listSessionsQuerySchema,
      success: { data: listSessionsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
      },
      description:
        "List sessions with filtering, sorting, optional workspace grouping (view=by_workspace), optional git branch/PR metadata (include=git), or lightweight id projection (fields=id,archived; page_size ceiling relaxed to 10000). Paginate with page_token, 1-based page, or flat before_id/after_id cursors.",
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;

      const query: NormalizedQuery = {
        workspaceFilter: asArray(raw.workspace_id),
        busy: raw.busy,
        activities: asArray(raw.activity),
        updatedAfter: raw.updated_after === undefined ? undefined : Date.parse(raw.updated_after),
        updatedBefore: raw.updated_before === undefined ? undefined : Date.parse(raw.updated_before),
        archived: raw.archived ?? 'false',
        hasPrompt: raw.has_prompt,
        view: raw.view ?? 'flat',
        groupPageSize: raw.group_page_size ?? DEFAULT_GROUP_PAGE_SIZE,
        sort: raw.sort ?? 'updated_at_desc',
        includeGit: parseSessionIncludeDomains(raw.include).includes('git'),
        pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
        projection: parseSessionFields(raw.fields).length > 0,
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

      const { roots, registeredWorkspaceIds, visibleWorkspaceIds } =
        await loadWorkspaceVisibility(core);
      const index = core.accessor.get(ISessionIndex);
      const page = await index.listRecent({
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

      const cwdOf = (summary: SessionSummary): string | undefined => {
        const candidate = summary.cwd ?? roots.get(summary.workspaceId);
        return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
      };

      const filtered = page.items.filter((summary) => {
        if (!visibleWorkspaceIds.has(summary.workspaceId)) return false;
        if (cwdOf(summary) === undefined) return false;
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
        if (query.busy !== undefined && factsOf(summary.id).busy !== query.busy) {
          return false;
        }
        if (
          query.activities !== undefined &&
          !query.activities.includes(mapSessionActivity(factsOf(summary.id)))
        ) {
          return false;
        }
        return true;
      });

      const comparator = makeComparator(query.sort);
      const sorted = filtered.toSorted(comparator);
      const keyOf = sortKeyOf(query.sort);
      const ascending = query.sort === 'updated_at_asc';
      const requiredCwdOf = (summary: SessionSummary): string => cwdOf(summary)!;

      const buildItems = async (summaries: readonly SessionSummary[]): Promise<Session[]> => {
        let gitBySession: ReadonlyMap<string, SessionGit> | undefined;
        if (query.includeGit) {
          gitBySession = await gitResolver.resolveAll(summaries, requiredCwdOf);
        }
        return summaries.map((summary) =>
          toWireSession(
            summary,
            requiredCwdOf(summary),
            factsOf(summary.id),
            gitBySession === undefined
              ? undefined
              : (gitBySession.get(summary.id) ?? GIT_DOMAIN_UNAVAILABLE),
          ),
        );
      };

      const projectIds = (summaries: readonly SessionSummary[]): SessionIdProjection[] =>
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
            const sortedSet = set.toSorted();
            canonical =
              sortedSet.length === 0
                ? workspaceId
                : (sortedSet.find((candidate) => registeredWorkspaceIds.has(candidate)) ??
                  (sortedSet[0] as string));
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
            : undefined;

        const groups = await Promise.all(
          windowGroups.map(async (group) => {
            const served = group.items.slice(0, query.groupPageSize);
            return {
              workspace_id: group.workspaceId,
              sessions: query.projection ? projectIds(served) : await buildItems(served),
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

      let window: SessionSummary[];
      let hasMore: boolean;
      const usesIdCursor = raw.before_id !== undefined || raw.after_id !== undefined;

      if (raw.before_id !== undefined) {
        const anchor = await index.get(raw.before_id);
        if (anchor === undefined) {
          window = [];
          hasMore = false;
        } else {
          const start = sorted.findIndex((item) => comparator(item, anchor) > 0);
          if (start === -1) {
            window = [];
            hasMore = false;
          } else {
            window = sorted.slice(start, start + query.pageSize);
            hasMore = start + query.pageSize < sorted.length;
          }
        }
      } else if (raw.after_id !== undefined) {
        const anchor = await index.get(raw.after_id);
        if (anchor === undefined) {
          window = [];
          hasMore = false;
        } else {
          const end = sorted.findIndex((item) => comparator(item, anchor) >= 0);
          const candidates = end === -1 ? sorted : sorted.slice(0, end);
          window = candidates.slice(0, query.pageSize);
          hasMore = candidates.length > query.pageSize;
        }
      } else {
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
        window = sorted.slice(start, start + query.pageSize);
        hasMore = start + query.pageSize < sorted.length;
      }

      const lastServed = window.at(-1);
      const nextPageToken =
        raw.page === undefined && !usesIdCursor && hasMore && lastServed !== undefined
          ? encodePageToken(fingerprint, keyOf(lastServed), lastServed.id)
          : undefined;

      const items = query.projection ? projectIds(window) : await buildItems(window);

      reply.send(
        okEnvelope(
          {
            items,
            total: sorted.length,
            has_more: hasMore,
            next_page_token: nextPageToken,
          },
          req.id,
        ),
      );
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionListRouteHost['get']>[2],
  );

  for (const action of ['archive', 'restore'] as const) {
    const batchRoute = defineRoute(
      {
        method: 'POST',
        path: `/sessions::${action}`,
        body: batchSessionsRequestSchema,
        success: { data: batchSessionsResponseSchema },
        errors: {
          [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        },
        description: `Batch-${action} sessions by id ({ ids }, <= 5000 unique). Per-item results — a missing session folds into its own item; cold sessions are patched without materialization.`,
        tags: ['sessions'],
      },
      async (req, reply) => {
        await runBatchArchive(core, action, req.body.ids, req.id, reply);
      },
    );
    app.post(
      batchRoute.path,
      batchRoute.options,
      batchRoute.handler as Parameters<SessionListRouteHost['post']>[2],
    );
  }
}
