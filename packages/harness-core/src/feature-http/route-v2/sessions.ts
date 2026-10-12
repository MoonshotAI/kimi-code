import { createHash } from 'node:crypto';

import type { Request, Response } from 'express';

import {
  AgentModelRef,
  MAIN_AGENT_ID,
  useApp,
  useInject,
  type AppCommands,
  type SessionHandle,
} from '@moonshot-ai/agent-core';

import {
  SessionIndexRef,
  type SessionIndexFace,
  type SessionSummaryRow,
} from '#/features/sessionIndex/index';
import {
  getWorkspaceEntry,
  resolveWorkspaceId,
  WorkspaceRef,
  type FsPullRequest,
  type WorkspaceGitPort,
  type WorkspacesState,
} from '#/features/workspaces/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, sendErr, sendOk } from '../route/http';
import {
  sessionBusy,
  sessionPendingInteraction,
  type SessionPendingInteraction,
} from '../route-features/status';
import { sendValidationDetails } from '../route-features/workspaces';

export const V2_HTTP_PREFIX = '/api/v2';

const ACTIVITY_STATUSES = ['running', 'approval', 'question', 'failed', 'idle'] as const;
type V2ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

const V2_SORTS = ['meta.updated_at_desc', 'meta.updated_at_asc', 'meta.created_at_desc'] as const;
type V2Sort = (typeof V2_SORTS)[number];

const V2_VIEWS = ['flat', 'by_workspace'] as const;
type V2View = (typeof V2_VIEWS)[number];

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_GROUP_PAGE_SIZE = 5;
const FULL_PAGE_SIZE_MAX = 100;
const IDS_PROJECTION_PAGE_SIZE_MAX = 10000;
const BATCH_IDS_MAX = 5000;
const BATCH_CONCURRENCY = 8;

const KNOWN_INCLUDE_DOMAINS = new Set(['git']);
const KNOWN_FIELDS = new Set(['id', 'archived']);

const GIT_DOMAIN_TTL_MS = 60_000;

interface V2GitDomain {
  readonly branch: string | null;
  readonly pull_request: {
    readonly number: number;
    readonly state: string;
    readonly url: string;
  } | null;
}

const GIT_DOMAIN_UNAVAILABLE: V2GitDomain = { branch: null, pull_request: null };

function mapPullRequest(pr: FsPullRequest | null): V2GitDomain['pull_request'] {
  if (pr === null) return null;
  return { number: pr.number, state: pr.state === 'draft' ? 'open' : pr.state, url: pr.url };
}

async function fetchGitDomain(git: WorkspaceGitPort, cwd: string): Promise<V2GitDomain> {
  try {
    const status = await git.status(cwd);
    return {
      branch: status.branch.length === 0 ? null : status.branch,
      pull_request: mapPullRequest(status.pullRequest),
    };
  } catch {
    return GIT_DOMAIN_UNAVAILABLE;
  }
}

interface ValidationDetail {
  readonly path: string;
  readonly message: string;
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
  readonly page?: number;
  readonly pageToken?: string;
  readonly projection: boolean;
}

interface SessionFacts {
  readonly live: boolean;
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly model?: string;
}

export function useV2SessionRoutes(prefix: string): void {
  const base = prefix.replace(/\/+$/, '');
  const gitDomainCache = new Map<string, { value: V2GitDomain; fetchedAt: number }>();

  useHttpRoute({
    id: 'v2.sessions.list',
    method: 'GET',
    path: `${base}/sessions`,
    handler: async (request, response) => {
      const parsed = readV2ListQuery(request.query as Record<string, unknown>);
      if ('details' in parsed) {
        sendValidationDetails(request, response, parsed.details);
        return;
      }
      const face = sessionIndexFacade(request, response);
      if (face === undefined) return;
      const app = useApp();
      const query = parsed;

      const fingerprint = queryFingerprint(query);
      let cursor: readonly [number, string] | undefined;
      if (query.pageToken !== undefined) {
        try {
          cursor = decodePageToken(query.pageToken, fingerprint);
        } catch (error) {
          if (error instanceof PageTokenMismatchError) {
            sendErr(request, response, ErrorCode.PAGE_TOKEN_MISMATCH, error.message);
            return;
          }
          throw error;
        }
      }

      const workspaces = useInject(WorkspaceRef).value;
      const state = workspaces?.state.value;
      const gitPort = workspaces?.fs?.git;
      let workspaceIds: readonly string[] | undefined;
      if (query.workspaceFilter !== undefined) {
        workspaceIds = [
          ...new Set(query.workspaceFilter.flatMap((id) => aliasSetOf(state, id))),
        ];
      }

      const rows = face.listAll({
        workspaceIds,
        archived: query.archived,
        updatedAfter: query.updatedAfter,
        updatedBefore: query.updatedBefore,
        hasPrompt: query.hasPrompt,
        sort: indexSortOf(query.sort),
      });

      const factsById = new Map<string, SessionFacts>();
      const factsOf = (id: string): SessionFacts => {
        let facts = factsById.get(id);
        if (facts === undefined) {
          facts = resolveSessionFacts(app, id);
          factsById.set(id, facts);
        }
        return facts;
      };

      const filtered =
        query.statuses === undefined
          ? rows
          : rows.filter((row) =>
              query.statuses?.includes(mapActivityStatus(factsOf(row.id), row.lastTurnOutcome)),
            );

      const comparator = makeComparator(query.sort);
      const keyOf = keyOfSort(query.sort);
      const ascending = query.sort === 'meta.updated_at_asc';

      const cwdOf = (row: SessionSummaryRow): string | null =>
        row.cwd ?? workspaceRootOf(state, row.workspaceId);

      const resolveGitDomains = async (
        rows: readonly SessionSummaryRow[],
      ): Promise<ReadonlyMap<string, V2GitDomain> | undefined> => {
        if (!query.includeGit) return undefined;
        const resolved = new Map<string, V2GitDomain>();
        if (gitPort === undefined) return resolved;
        const now = Date.now();
        const cwds = new Set<string>();
        for (const row of rows) {
          const cwd = cwdOf(row);
          if (cwd !== null) cwds.add(cwd);
        }
        const misses: string[] = [];
        for (const cwd of cwds) {
          const hit = gitDomainCache.get(cwd);
          if (hit !== undefined && now - hit.fetchedAt < GIT_DOMAIN_TTL_MS) {
            resolved.set(cwd, hit.value);
          } else {
            misses.push(cwd);
          }
        }
        await Promise.all(
          misses.map(async (cwd) => {
            const value = await fetchGitDomain(gitPort, cwd);
            gitDomainCache.set(cwd, { value, fetchedAt: now });
            resolved.set(cwd, value);
          }),
        );
        return resolved;
      };

      const buildItem = (
        row: SessionSummaryRow,
        gitByCwd?: ReadonlyMap<string, V2GitDomain>,
      ): Record<string, unknown> => {
        const facts = factsOf(row.id);
        const cwd = cwdOf(row);
        return {
          id: row.id,
          workspace: { id: row.workspaceId ?? '', cwd },
          meta: {
            title: row.title ?? null,
            last_prompt: row.lastPrompt ?? null,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
            archived: row.archived,
            archived_at: row.archivedAt ?? null,
          },
          activity: {
            status: mapActivityStatus(facts, row.lastTurnOutcome),
            model: facts.model ?? null,
          },
          git:
            gitByCwd === undefined
              ? undefined
              : ((cwd !== null ? gitByCwd.get(cwd) : undefined) ?? GIT_DOMAIN_UNAVAILABLE),
        };
      };

      const projectIds = (items: readonly SessionSummaryRow[]): readonly Record<string, unknown>[] =>
        items.map((row) => ({ id: row.id, archived: row.archived }));

      if (query.view === 'by_workspace') {
        interface SessionGroup {
          readonly workspaceId: string;
          readonly rep: SessionSummaryRow;
          readonly items: SessionSummaryRow[];
        }
        const canonicalById = new Map<string, string>();
        const canonicalIdOf = (workspaceId: string | null): string => {
          if (workspaceId === null) return '';
          let canonical = canonicalById.get(workspaceId);
          if (canonical === undefined) {
            canonical = aliasSetOf(state, workspaceId).toSorted()[0] as string;
            canonicalById.set(workspaceId, canonical);
          }
          return canonical;
        };
        const byWorkspace = new Map<string, SessionGroup>();
        for (const row of filtered) {
          const groupId = canonicalIdOf(row.workspaceId);
          const group = byWorkspace.get(groupId);
          if (group === undefined) {
            byWorkspace.set(groupId, { workspaceId: groupId, rep: row, items: [row] });
          } else {
            group.items.push(row);
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
        if (query.page !== undefined) {
          start = (query.page - 1) * query.pageSize;
        } else if (cursor !== undefined) {
          const [cursorKey, cursorId] = cursor;
          const cursorGroup: SessionGroup = {
            workspaceId: cursorId,
            rep: { id: cursorId, updatedAt: cursorKey, createdAt: cursorKey } as SessionSummaryRow,
            items: [],
          };
          start = groupList.findIndex((group) => groupComparator(group, cursorGroup) > 0);
          if (start === -1) start = groupList.length;
        }

        const windowGroups = groupList.slice(start, start + query.pageSize);
        const hasMore = start + query.pageSize < groupList.length;
        const lastGroup = windowGroups.at(-1);
        const nextPageToken =
          query.page === undefined && hasMore && lastGroup !== undefined
            ? encodePageToken(fingerprint, keyOf(lastGroup.rep), lastGroup.workspaceId)
            : null;

        const gitByCwd = query.projection
          ? undefined
          : await resolveGitDomains(
              windowGroups.flatMap((group) => group.items.slice(0, query.groupPageSize)),
            );
        const groups = windowGroups.map((group) => {
          const served = group.items.slice(0, query.groupPageSize);
          return {
            workspace: { id: group.workspaceId, cwd: cwdOf(group.rep) },
            sessions: query.projection
              ? projectIds(served)
              : served.map((row) => buildItem(row, gitByCwd)),
            total: group.items.length,
          };
        });

        sendOk(request, response, {
          groups,
          total: groupList.length,
          has_more: hasMore,
          next_page_token: nextPageToken,
        });
        return;
      }

      let start = 0;
      if (query.page !== undefined) {
        start = (query.page - 1) * query.pageSize;
      } else if (cursor !== undefined) {
        const [cursorKey, cursorId] = cursor;
        const cursorRow = {
          id: cursorId,
          updatedAt: cursorKey,
          createdAt: cursorKey,
        } as SessionSummaryRow;
        start = filtered.findIndex((row) => comparator(row, cursorRow) > 0);
        if (start === -1) start = filtered.length;
      }

      const window = filtered.slice(start, start + query.pageSize);
      const hasMore = start + query.pageSize < filtered.length;
      const lastServed = window.at(-1);
      const nextPageToken =
        query.page === undefined && hasMore && lastServed !== undefined
          ? encodePageToken(fingerprint, keyOf(lastServed), lastServed.id)
          : null;

      const gitByCwd = query.projection ? undefined : await resolveGitDomains(window);
      sendOk(request, response, {
        items: query.projection
          ? projectIds(window)
          : window.map((row) => buildItem(row, gitByCwd)),
        total: filtered.length,
        has_more: hasMore,
        next_page_token: nextPageToken,
      });
    },
  });

  for (const action of ['archive', 'restore'] as const) {
    useHttpRoute({
      id: `v2.sessions.${action}`,
      method: 'POST',
      path: `${base}/sessions\\:${action}`,
      handler: async (request, response) => {
        const body = readV2BatchBody(request.body);
        if ('details' in body) {
          sendValidationDetails(request, response, body.details);
          return;
        }
        const app = useApp();
        const archived = action === 'archive';
        const ids = [...new Set(body.ids)];
        const outcomes = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
          try {
            const record = await app.space.get(id);
            if (record === undefined) {
              return {
                id,
                ok: false as const,
                error: { code: ErrorCode.SESSION_NOT_FOUND, message: `session ${id} does not exist` },
              };
            }
            await app.updateSession(id, {
              metadata: {
                ...record.metadata,
                archived,
                archived_at: archived ? new Date().toISOString() : undefined,
              },
            });
            if (archived) await app.close(id);
            return { id, ok: true as const };
          } catch (error) {
            return {
              id,
              ok: false as const,
              error: {
                code: ErrorCode.INTERNAL_ERROR,
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
        });
        const succeeded = outcomes.filter((outcome) => outcome.ok).length;
        sendOk(request, response, {
          results: outcomes,
          succeeded,
          failed: outcomes.length - succeeded,
        });
      },
    });
  }
}

function sessionIndexFacade(request: Request, response: Response): SessionIndexFace | undefined {
  const face = useInject(SessionIndexRef).value;
  if (face === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.SESSION_INDEX_UNAVAILABLE,
      'session index is unavailable (sessionIndex feature is not installed)',
    );
    return undefined;
  }
  return face;
}

function resolveSessionFacts(app: AppCommands, sessionId: string): SessionFacts {
  const live = app.get(sessionId);
  if (live === undefined) {
    return { live: false, busy: false, mainTurnActive: false, pendingInteraction: 'none' };
  }
  const status = live.status();
  const model = activityModelOf(live);
  return {
    live: true,
    busy: sessionBusy(live),
    mainTurnActive: status.mainTurnActive,
    pendingInteraction: sessionPendingInteraction(live),
    lastTurnReason: status.lastTurnReason,
    model,
  };
}

function activityModelOf(session: SessionHandle): string | undefined {
  const main = session.get(MAIN_AGENT_ID);
  const bound = main?.resolve(AgentModelRef)?.current.value.alias;
  if (typeof bound === 'string' && bound.length > 0) return bound;
  const configured = main?.config?.model.model;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

function mapActivityStatus(facts: SessionFacts, persistedOutcome: string | null): V2ActivityStatus {
  if (facts.pendingInteraction === 'approval') return 'approval';
  if (facts.pendingInteraction === 'question') return 'question';
  if (facts.busy || facts.mainTurnActive) return 'running';
  if (facts.lastTurnReason === 'failed') return 'failed';
  if (!facts.live && persistedOutcome === 'failed') return 'failed';
  return 'idle';
}

function indexSortOf(sort: V2Sort): 'updated_at_desc' | 'updated_at_asc' | 'created_at_desc' {
  if (sort === 'meta.updated_at_asc') return 'updated_at_asc';
  if (sort === 'meta.created_at_desc') return 'created_at_desc';
  return 'updated_at_desc';
}

function keyOfSort(sort: V2Sort): (row: SessionSummaryRow) => number {
  return sort === 'meta.created_at_desc' ? (row) => row.createdAt : (row) => row.updatedAt;
}

function makeComparator(sort: V2Sort): (a: SessionSummaryRow, b: SessionSummaryRow) => number {
  const keyOf = keyOfSort(sort);
  const ascending = sort === 'meta.updated_at_asc';
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ascending ? ka - kb : kb - ka;
    const order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return ascending ? order : -order;
  };
}

function aliasSetOf(state: WorkspacesState | undefined, id: string): readonly string[] {
  if (state === undefined) return [id];
  const canonical = resolveWorkspaceId(state, id);
  const set = new Set<string>([canonical, id]);
  for (const [aliasId, target] of state.aliases) {
    if (target === canonical) set.add(aliasId);
  }
  return [...set];
}

function workspaceRootOf(state: WorkspacesState | undefined, workspaceId: string | null): string | null {
  if (state === undefined || workspaceId === null) return null;
  return getWorkspaceEntry(state, workspaceId)?.root ?? null;
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

class PageTokenMismatchError extends Error {}

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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: (R | undefined)[] = items.map(() => undefined);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results as R[];
}

function readV2ListQuery(
  query: Record<string, unknown>,
): NormalizedQuery | { readonly details: readonly ValidationDetail[] } {
  const details: ValidationDetail[] = [];
  const workspaceFilter = readStringArray(query['workspace.id'], 'workspace.id', details);
  const statuses = readEnumArray(query['activity.status'], 'activity.status', ACTIVITY_STATUSES, details);
  const updatedAfter = readCoercedInt(query['meta.updated_after'], 'meta.updated_after', 0, details);
  const updatedBefore = readCoercedInt(query['meta.updated_before'], 'meta.updated_before', 0, details);
  const archived = readEnumSingle(query['meta.archived'], 'meta.archived', ['true', 'false', 'all'] as const, details);
  const hasPrompt = readEnumSingle(query['meta.has_prompt'], 'meta.has_prompt', ['true', 'false'] as const, details);
  const view = readEnumSingle(query['view'], 'view', V2_VIEWS, details);
  const groupPageSize = readCoercedInt(query['group.page_size'], 'group.page_size', 1, details);
  const sort = readEnumSingle(query['sort'], 'sort', V2_SORTS, details);
  const include = readStringSingle(query['include'], 'include', details);
  const fieldsRaw = readStringSingle(query['fields'], 'fields', details);
  const pageSize = readCoercedInt(query['page_size'], 'page_size', 1, details);
  const page = readCoercedInt(query['page'], 'page', 1, details);
  const pageToken = readStringSingle(query['page_token'], 'page_token', details, true);
  if (details.length > 0) return { details };

  const cross: ValidationDetail[] = [];
  if (page !== undefined && pageToken !== undefined) {
    cross.push({ path: 'page', message: 'page and page_token are mutually exclusive' });
  }
  const domains = (include ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const domain of domains) {
    if (!KNOWN_INCLUDE_DOMAINS.has(domain)) {
      cross.push({ path: 'include', message: `unknown domain '${domain}'` });
    }
  }
  const fields = [
    ...new Set(
      (fieldsRaw ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  for (const field of fields) {
    if (!KNOWN_FIELDS.has(field)) {
      cross.push({ path: 'fields', message: `unknown field '${field}'` });
    }
  }
  const projection = fields.length > 0 && fields.every((field) => KNOWN_FIELDS.has(field));
  if (projection && fields.length !== 2) {
    cross.push({
      path: 'fields',
      message: "unsupported fields projection; the only supported value is 'id,archived'",
    });
  }
  const includeGit = domains.includes('git');
  if (projection && includeGit) {
    cross.push({ path: 'include', message: 'include=git is not available with the ids projection' });
  }
  const pageSizeMax = projection ? IDS_PROJECTION_PAGE_SIZE_MAX : FULL_PAGE_SIZE_MAX;
  if (pageSize !== undefined && pageSize > pageSizeMax) {
    cross.push({
      path: 'page_size',
      message: projection
        ? `page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
        : `page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
    });
  }
  if (groupPageSize !== undefined) {
    if (view !== 'by_workspace') {
      cross.push({ path: 'group.page_size', message: "group.page_size requires view='by_workspace'" });
    } else if (groupPageSize > pageSizeMax) {
      cross.push({
        path: 'group.page_size',
        message: projection
          ? `group.page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
          : `group.page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
      });
    }
  }
  if (cross.length > 0) return { details: cross };

  return {
    workspaceFilter,
    statuses,
    updatedAfter,
    updatedBefore,
    archived: archived ?? 'false',
    hasPrompt: hasPrompt === undefined ? undefined : hasPrompt === 'true',
    view: view ?? 'flat',
    groupPageSize: groupPageSize ?? DEFAULT_GROUP_PAGE_SIZE,
    sort: sort ?? 'meta.updated_at_desc',
    includeGit,
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
    page,
    pageToken,
    projection,
  };
}

function readV2BatchBody(body: unknown): { readonly ids: readonly string[] } | { readonly details: readonly ValidationDetail[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      details: [
        {
          path: '',
          message: `Invalid input: expected object, received ${body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body}`,
        },
      ],
    };
  }
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) {
    return {
      details: [
        {
          path: 'ids',
          message: `Invalid input: expected array, received ${ids === undefined ? 'undefined' : typeof ids}`,
        },
      ],
    };
  }
  const details: ValidationDetail[] = [];
  if (ids.length === 0) {
    details.push({ path: 'ids', message: 'Too small: expected array to have >=1 items' });
  }
  ids.forEach((id, index) => {
    if (typeof id !== 'string' || id.length === 0) {
      details.push({
        path: `ids.${index}`,
        message:
          typeof id !== 'string'
            ? `Invalid input: expected string, received ${id === null ? 'null' : typeof id}`
            : 'Too small: expected string to have >=1 characters',
      });
    }
  });
  if (details.length > 0) return { details };
  if (new Set(ids as readonly string[]).size > BATCH_IDS_MAX) {
    return {
      details: [
        { path: 'ids', message: `ids must contain at most ${BATCH_IDS_MAX} unique entries` },
      ],
    };
  }
  return { ids: ids as readonly string[] };
}

function readStringArray(
  value: unknown,
  path: string,
  details: ValidationDetail[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      details.push({ path, message: `Invalid input: expected string, received ${item === null ? 'null' : typeof item}` });
      continue;
    }
    if (item.length === 0) {
      details.push({ path, message: 'Too small: expected string to have >=1 characters' });
      continue;
    }
    out.push(item);
  }
  return out;
}

function readEnumArray<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
  details: ValidationDetail[],
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  const out: T[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      details.push({ path, message: `Invalid input: expected string, received ${item === null ? 'null' : typeof item}` });
      continue;
    }
    if (!options.includes(item as T)) {
      details.push({ path, message: `Invalid option: expected one of ${options.map((option) => `"${option}"`).join('|')}` });
      continue;
    }
    out.push(item as T);
  }
  return out;
}

function readEnumSingle<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
  details: ValidationDetail[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    details.push({ path, message: `Invalid input: expected string, received ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}` });
    return undefined;
  }
  if (!options.includes(value as T)) {
    details.push({ path, message: `Invalid option: expected one of ${options.map((option) => `"${option}"`).join('|')}` });
    return undefined;
  }
  return value as T;
}

function readStringSingle(
  value: unknown,
  path: string,
  details: ValidationDetail[],
  nonEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    details.push({ path, message: `Invalid input: expected string, received ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}` });
    return undefined;
  }
  if (nonEmpty && value.length === 0) {
    details.push({ path, message: 'Too small: expected string to have >=1 characters' });
    return undefined;
  }
  return value;
}

function readCoercedInt(
  value: unknown,
  path: string,
  min: number,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && !Array.isArray(value)) {
    details.push({ path, message: `Invalid input: expected number, received ${value === null ? 'null' : typeof value}` });
    return undefined;
  }
  const coerced = Number(value as string | string[]);
  if (Number.isNaN(coerced)) {
    details.push({ path, message: 'Invalid input: expected number, received NaN' });
    return undefined;
  }
  if (!Number.isInteger(coerced)) {
    details.push({ path, message: 'Invalid input: expected int, received number' });
    return undefined;
  }
  if (coerced < min) {
    details.push({ path, message: `Too small: expected number to be >=${min}` });
    return undefined;
  }
  return coerced;
}
