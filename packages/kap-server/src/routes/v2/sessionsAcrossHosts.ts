import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ErrorCode } from '../../protocol/error-codes';
import {
  HostSourceError,
  hostGet,
  hostProjects,
  type HostSources,
} from '../../services/hosts/hostFanout';
import type {
  V2SessionGroupsPageData,
  V2SessionsListOutcome,
  V2SessionsListQuery,
  V2SessionsPageData,
} from './sessions';
import {
  compareSessionGroups,
  compareSessionPositions,
  sessionPositionOf,
  type SessionPosition,
} from './sessionOrder';

type Page = V2SessionsPageData | V2SessionGroupsPageData;
type Entry = Record<string, unknown>;
type Query = Omit<V2SessionsListQuery, 'hosts'>;

interface Source {
  readonly key: string;
  readonly hostId?: string;
  readonly workspaceIds?: string[];
  fetch(query: Query): Promise<Page>;
  total?: number;
}

interface Buffer {
  readonly source: Source;
  token?: string;
  queue: Entry[];
  next: string | null;
}

interface Context {
  readonly query: Query;
  readonly groups: boolean;
  readonly projection: boolean;
  readonly position: (entry: Entry) => SessionPosition;
  readonly compare: (a: SessionPosition, b: SessionPosition) => number;
}

const positionSchema = z.object({ key: z.number().finite(), id: z.string() });
const mergeTokenSchema = z.object({
  v: z.literal(2),
  q: z.string().length(16),
  h: z.array(z.string()),
  a: positionSchema,
  c: z.record(z.string(), z.object({ t: z.string().optional(), k: positionSchema.optional() }).strict()),
}).strict();

type MergeToken = z.infer<typeof mergeTokenSchema>;

const SOURCE_PAGE_SIZE_MAX = 100;

class TokenMismatchError extends Error {}

function fingerprint(query: Query): string {
  const normalized = Object.fromEntries(
    Object.entries({ ...query, page: undefined, page_token: undefined })
      .filter(([, value]) => value !== undefined),
  );
  return createHash('sha256').update(JSON.stringify(normalized, Object.keys(normalized).toSorted())).digest('base64url').slice(0, 16);
}

function decodeToken(raw: string, context: Context, hostIds: readonly string[]): MergeToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new TokenMismatchError('page_token is corrupted; discard it and restart from the first page');
  }
  const result = mergeTokenSchema.safeParse(parsed);
  if (!result.success || result.data.q !== fingerprint(context.query) || result.data.h.join('\0') !== hostIds.join('\0')) {
    throw new TokenMismatchError('page_token does not match this query and host set; discard it and restart from the first page');
  }
  return result.data;
}

function isGroups(page: Page): page is V2SessionGroupsPageData {
  return 'groups' in page;
}

function collectSources(
  query: Query,
  hosts: HostSources,
  local: (query: V2SessionsListQuery) => Promise<V2SessionsListOutcome>,
): Promise<{ sources: Source[]; hostIds: string[] }> {
  const filter = query['workspace.id'] === undefined ? undefined : new Set([query['workspace.id']].flat());
  const configured = hosts.sources();
  return Promise.all(configured.map(async (host): Promise<Source | undefined> => {
    const session = host.session;
    if (session === undefined) return undefined;
    let projectIds: string[];
    try {
      projectIds = (await hostProjects<{ id: string; kind: string }>(session)).map((project) => project.id);
    } catch (error) {
      if (error instanceof HostSourceError && error.code !== undefined) throw error;
      return undefined;
    }
    const allowed = filter === undefined ? projectIds : projectIds.filter((id) => filter.has(id));
    if (allowed.length === 0) return undefined;
    return {
      key: host.id,
      hostId: host.id,
      workspaceIds: allowed,
      fetch: (next) => hostGet<Page>(session, '/api/v2/sessions', next),
    };
  })).then((remote) => ({
    sources: [{
      key: '',
      fetch: (nextQuery) => local(nextQuery).then((outcome) => outcome.ok ? outcome.data : Promise.reject(new HostSourceError(outcome.code, outcome.message))),
    }, ...remote.filter((source): source is Source => source !== undefined)],
    hostIds: ['', ...configured.map((host) => host.id)],
  }));
}

function project(entry: Entry, groups: boolean, hostId: string | undefined): Entry {
  const sessions = groups ? (entry['sessions'] as Entry[]) : [entry];
  const ids = sessions.map((session) => ({
    id: session['id'],
    archived: session['meta'] === undefined
      ? session['archived']
      : (session['meta'] as Record<string, unknown>)['archived'],
    ...(hostId === undefined ? {} : { host_id: hostId }),
  }));
  return groups ? { ...entry, sessions: ids } : ids[0]!;
}

async function stamp(entry: Entry, context: Context, source: Source): Promise<Entry> {
  const hostId = source.hostId;
  if (context.projection) {
    if (context.groups && (context.query['group.page_size'] ?? 5) > SOURCE_PAGE_SIZE_MAX) {
      const page = await source.fetch({
        ...context.query,
        view: 'flat',
        'workspace.id': (entry['workspace'] as { id: string }).id,
        'group.page_size': undefined,
        page: undefined,
        page_token: undefined,
        page_size: context.query['group.page_size'],
      }) as V2SessionsPageData;
      entry = { ...entry, sessions: page.items };
    }
    return project(entry, context.groups, hostId);
  }
  if (hostId === undefined) return entry;
  if (!context.groups) return { ...entry, host_id: hostId };
  return {
    ...entry,
    sessions: (entry['sessions'] as Entry[]).map((session) => ({ ...session, host_id: hostId })),
    host_id: hostId,
  };
}

async function load(source: Source, context: Context, token?: string, after?: SessionPosition): Promise<Buffer> {
  const seen = new Set<string>();
  const groupPageSize = context.query['group.page_size'];
  for (;;) {
    let page: Page;
    try {
      page = await source.fetch({
        ...context.query,
        fields: undefined,
        page: undefined,
        page_token: token,
        page_size: Math.min(context.query.page_size ?? 50, SOURCE_PAGE_SIZE_MAX),
        'group.page_size': groupPageSize !== undefined && groupPageSize > SOURCE_PAGE_SIZE_MAX ? 1 : groupPageSize,
        'workspace.id': source.workspaceIds ?? context.query['workspace.id'],
      });
    } catch (error) {
      if (source.hostId !== undefined && !(error instanceof HostSourceError && error.code !== undefined)) {
        if (context.query.page_token === undefined) return { source, token, queue: [], next: null };
        throw new HostSourceError(ErrorCode.HOST_UNAVAILABLE, `host "${source.hostId}" is unavailable`);
      }
      throw error;
    }
    const queue = (isGroups(page) ? page.groups : page.items).filter((entry) =>
      after === undefined || context.compare(context.position(entry), after) > 0,
    );
    source.total = page.total;
    if (queue.length > 0 || page.next_page_token === null) return { source, token, queue, next: page.next_page_token };
    if (page.next_page_token === token || seen.has(page.next_page_token)) {
      throw new Error(`session listing returned a repeated cursor for host "${source.hostId ?? 'local'}"`);
    }
    seen.add(page.next_page_token);
    token = page.next_page_token;
  }
}

async function mergePage(
  context: Context,
  sources: Source[],
  hostIds: readonly string[],
): Promise<Page> {
  const token = context.query.page_token ? decodeToken(context.query.page_token, context, hostIds) : undefined;
  const active = token === undefined ? sources : sources.filter((source) => token.c[source.key] !== undefined);
  const buffers = await Promise.all(active.map((source) => load(source, context, token?.c[source.key]?.t, token?.a ?? token?.c[source.key]?.k)));
  const entries: Entry[] = [];
  const emitted = new Map<string, SessionPosition>();
  let after: SessionPosition | undefined;
  while (entries.length < (context.query.page_size ?? 50)) {
    await Promise.all(buffers.filter((buffer) => buffer.queue.length === 0 && buffer.next !== null)
      .map(async (buffer) => {
        const next = await load(buffer.source, context, buffer.next ?? undefined, token?.a ?? emitted.get(buffer.source.key));
        buffer.queue = next.queue;
        buffer.next = next.next;
      }));
    let best: Buffer | undefined;
    for (const buffer of buffers) {
      if (buffer.queue.length === 0) continue;
      if (best === undefined || context.compare(context.position(buffer.queue[0]!), context.position(best.queue[0]!)) < 0) best = buffer;
    }
    if (best === undefined) break;
    const entry = best.queue.shift()!;
    after = context.position(entry);
    emitted.set(best.source.key, after);
    entries.push(await stamp(entry, context, best.source));
  }
  const cursors = Object.fromEntries(buffers.flatMap((buffer) =>
    buffer.queue.length > 0 || buffer.next !== null
      ? [[buffer.source.key, { t: buffer.token, k: emitted.get(buffer.source.key) }]]
      : emitted.has(buffer.source.key)
        ? [[buffer.source.key, { k: emitted.get(buffer.source.key) }]]
        : [],
  ));
  const hasMore = buffers.some((buffer) => buffer.queue.length > 0 || buffer.next !== null);
  const total = sources.reduce((sum, source) => sum + (source.total ?? 0), 0);
  for (const buffer of buffers) buffer.queue = [];
  const nextToken = hasMore ? Buffer.from(JSON.stringify({ v: 2, q: fingerprint(context.query), h: [...hostIds], a: after as SessionPosition, c: cursors } satisfies MergeToken)).toString('base64url') : null;
  const base = { total, has_more: hasMore, next_page_token: nextToken };
  return (context.groups ? { ...base, groups: entries } : { ...base, items: entries }) as Page;
}

export async function listSessionsAcrossHosts(
  query: V2SessionsListQuery,
  hosts: HostSources,
  local: (query: V2SessionsListQuery) => Promise<V2SessionsListOutcome>,
): Promise<V2SessionsListOutcome> {
  const { hosts: _hosts, ...base } = query;
  const groups = base.view === 'by_workspace';
  const sort = base.sort ?? 'meta.updated_at_desc';
  const context: Context = {
    query: base,
    groups,
    projection: (base.fields ?? '').trim().length > 0,
    position: (entry) => sessionPositionOf(groups, sort, entry),
    compare: groups
      ? (a, b) => compareSessionGroups(sort, a, b)
      : (a, b) => compareSessionPositions(sort, a, b),
  };
  try {
    const { sources, hostIds } = await collectSources(base, hosts, local);
    let data: Page;
    if (context.query.page === undefined || context.query.page === 1) {
      data = await mergePage(context, sources, hostIds);
    } else {
      const page = context.query.page;
      let token: string | undefined;
      for (let index = 1; index < page; index++) {
        const previous = await mergePage({ ...context, query: { ...context.query, page_token: token } }, sources, hostIds);
        token = previous.next_page_token ?? undefined;
        if (token === undefined) return { ok: true, data: { ...previous, has_more: false, next_page_token: null } };
      }
      data = await mergePage({ ...context, query: { ...context.query, page_token: token } }, sources, hostIds);
      data.next_page_token = null;
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof TokenMismatchError) return { ok: false, code: ErrorCode.PAGE_TOKEN_MISMATCH, message: error.message };
    if (error instanceof HostSourceError && error.code !== undefined) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
