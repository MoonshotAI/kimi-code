import { ErrorCode } from '../../protocol/error-codes';
import {
  HostSourceError,
  hostGet,
  hostProjects,
  type HostQuery,
  type HostSources,
} from '../../services/hosts/hostFanout';
import type {
  V2SessionGroupsPageData,
  V2SessionsListOutcome,
  V2SessionsListQuery,
  V2SessionsPageData,
} from './sessions';

type Page = V2SessionsPageData | V2SessionGroupsPageData;
type Entry = Record<string, unknown>;

interface Source {
  readonly key: string;
  readonly hostId?: string;
  fetch(query: V2SessionsListQuery): Promise<Page>;
}

interface Cursor {
  readonly t?: string;
  readonly k?: readonly [number, string];
}

interface MergeToken {
  readonly v: 1;
  readonly c: Readonly<Record<string, Cursor>>;
  readonly n: Readonly<Record<string, number>>;
}

const TOKEN_VERSION = 1;

class TokenMismatchError extends Error {}

function encodeToken(token: Omit<MergeToken, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...token })).toString('base64url');
}

function decodeToken(raw: string): MergeToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new TokenMismatchError('page_token is corrupted; discard it and restart from the first page');
  }
  const token = parsed as Partial<MergeToken>;
  if (token.v !== TOKEN_VERSION || typeof token.c !== 'object' || token.c === null || typeof token.n !== 'object' || token.n === null) {
    throw new TokenMismatchError('page_token was not issued for a listing across hosts; discard it and restart from the first page');
  }
  return token as MergeToken;
}

function isGroups(page: Page): page is V2SessionGroupsPageData {
  return 'groups' in page;
}

function entriesOf(page: Page): Entry[] {
  return (isGroups(page) ? page.groups : page.items) as Entry[];
}

function toHostQuery(query: V2SessionsListQuery): HostQuery {
  const { hosts: _hosts, ...rest } = query;
  return rest as HostQuery;
}

function stamp(entry: Entry, hostId: string | undefined, groups: boolean): Entry {
  if (hostId === undefined) return entry;
  if (!groups) return { ...entry, host_id: hostId };
  const sessions = (entry['sessions'] as Entry[]).map((session) => ({ ...session, host_id: hostId }));
  return { ...entry, sessions, host_id: hostId };
}

function positionOf(groups: boolean, sort: V2SessionsListQuery['sort']): (entry: Entry) => readonly [number, string] {
  const field = sort === 'meta.created_at_desc' ? 'created_at' : 'updated_at';
  return (entry) => {
    const session = groups ? (entry['sessions'] as Entry[])[0]! : entry;
    const meta = session['meta'] as Record<string, number>;
    const id = groups ? (entry['workspace'] as { id: string }).id : (entry['id'] as string);
    return [meta[field]!, id];
  };
}

function comparePositions(sort: V2SessionsListQuery['sort']): (a: readonly [number, string], b: readonly [number, string]) => number {
  const ascending = sort === 'meta.updated_at_asc';
  return (a, b) => {
    if (a[0] !== b[0]) return ascending ? a[0] - b[0] : b[0] - a[0];
    const order = a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return ascending ? order : -order;
  };
}

function buildPage(groups: boolean, entries: Entry[], total: number, hasMore: boolean, token: string | null, unavailable: string[]): Page {
  const base = { total, has_more: hasMore, next_page_token: token, unavailable_hosts: unavailable };
  return (groups ? { ...base, groups: entries } : { ...base, items: entries }) as Page;
}

async function collectSources(
  query: V2SessionsListQuery,
  hosts: HostSources,
  local: (query: V2SessionsListQuery) => Promise<V2SessionsListOutcome>,
): Promise<{ sources: Source[]; unavailable: string[] }> {
  const filter = query['workspace.id'] === undefined ? undefined : new Set([query['workspace.id']].flat());
  const unavailable: string[] = [];
  const remote = await Promise.all(
    hosts.sources().map(async (host): Promise<Source | undefined> => {
      const session = host.session;
      if (session === undefined) {
        unavailable.push(host.id);
        return undefined;
      }
      let projectIds: string[];
      try {
        projectIds = (await hostProjects<{ id: string; kind: string }>(session)).map((project) => project.id);
      } catch {
        unavailable.push(host.id);
        return undefined;
      }
      const allowed = filter === undefined ? projectIds : projectIds.filter((id) => filter.has(id));
      if (allowed.length === 0) return undefined;
      return {
        key: host.id,
        hostId: host.id,
        fetch: (next) => hostGet<Page>(session, '/api/v2/sessions', toHostQuery({ ...next, 'workspace.id': allowed })),
      };
    }),
  );
  const localSource: Source = {
    key: '',
    fetch: async (next) => {
      const outcome = await local(next);
      if (!outcome.ok) throw new HostSourceError(outcome.code, outcome.message);
      return outcome.data;
    },
  };
  const order = new Map(hosts.sources().map((host, index) => [host.id, index]));
  unavailable.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { sources: [localSource, ...remote.filter((source): source is Source => source !== undefined)], unavailable };
}

async function fetchOrDrop(
  source: Source,
  query: V2SessionsListQuery,
  unavailable: string[],
): Promise<Page | undefined> {
  try {
    return await source.fetch(query);
  } catch (error) {
    if (source.hostId === undefined) throw error;
    unavailable.push(source.hostId);
    return undefined;
  }
}

async function concatenate(
  query: V2SessionsListQuery,
  sources: Source[],
  unavailable: string[],
  groups: boolean,
): Promise<Page> {
  const token = query.page_token === undefined ? undefined : decodeToken(query.page_token);
  const active = token === undefined ? sources : sources.filter((source) => token.c[source.key] !== undefined);
  const totals: Record<string, number> = { ...token?.n };
  const cursors: Record<string, Cursor> = {};
  const entries: Entry[] = [];
  const pages = await Promise.all(
    active.map(async (source) => ({
      source,
      page: await fetchOrDrop(source, { ...query, page_token: token?.c[source.key]?.t }, unavailable),
    })),
  );
  for (const { source, page } of pages) {
    if (page === undefined) continue;
    totals[source.key] = page.total;
    entries.push(...entriesOf(page).map((entry) => stamp(entry, source.hostId, groups)));
    if (page.next_page_token !== null) cursors[source.key] = { t: page.next_page_token };
  }
  const hasMore = Object.keys(cursors).length > 0;
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return buildPage(groups, entries, total, hasMore, hasMore ? encodeToken({ c: cursors, n: totals }) : null, unavailable);
}

async function topPage(
  query: V2SessionsListQuery,
  sources: Source[],
  unavailable: string[],
  groups: boolean,
): Promise<Page> {
  const page = query.page!;
  const pageSize = query.page_size ?? 50;
  const position = positionOf(groups, query.sort);
  const compare = comparePositions(query.sort);
  const collected = await Promise.all(
    sources.map(async (source) => {
      const pages = await Promise.all(
        Array.from({ length: page }, (_, index) => fetchOrDrop(source, { ...query, page: index + 1 }, unavailable)),
      );
      if (pages.some((candidate) => candidate === undefined)) return { total: 0, entries: [] as Entry[] };
      const fetched = pages as Page[];
      return {
        total: fetched[0]!.total,
        entries: fetched.flatMap((candidate) => entriesOf(candidate).map((entry) => stamp(entry, source.hostId, groups))),
      };
    }),
  );
  const total = collected.reduce((sum, source) => sum + source.total, 0);
  const merged = collected
    .flatMap((source) => source.entries)
    .toSorted((a, b) => compare(position(a), position(b)))
    .slice((page - 1) * pageSize, page * pageSize);
  return buildPage(groups, merged, total, page * pageSize < total, null, [...new Set(unavailable)]);
}

interface SourceBuffer {
  readonly source: Source;
  readonly cursor: Cursor;
  readonly queue: Entry[];
  readonly hasMore: boolean;
  readonly next: string | null;
  consumed?: readonly [number, string];
}

async function mergePage(
  query: V2SessionsListQuery,
  sources: Source[],
  unavailable: string[],
  groups: boolean,
): Promise<Page> {
  const token = query.page_token === undefined ? undefined : decodeToken(query.page_token);
  const pageSize = query.page_size ?? 50;
  const position = positionOf(groups, query.sort);
  const compare = comparePositions(query.sort);
  const totals: Record<string, number> = { ...token?.n };
  const active = token === undefined ? sources : sources.filter((source) => token.c[source.key] !== undefined);

  const load = async (source: Source, start: Cursor): Promise<SourceBuffer | undefined> => {
    let cursor = start;
    for (;;) {
      const page = await fetchOrDrop(source, { ...query, page_token: cursor.t }, unavailable);
      if (page === undefined) return undefined;
      totals[source.key] = page.total;
      const after = cursor.k;
      const queue = entriesOf(page).filter((entry) => after === undefined || compare(position(entry), after) > 0);
      if (queue.length > 0 || !page.has_more || page.next_page_token === null) {
        return { source, cursor, queue, hasMore: page.has_more && page.next_page_token !== null, next: page.next_page_token };
      }
      cursor = { t: page.next_page_token };
    }
  };

  let buffers = (await Promise.all(active.map((source) => load(source, token?.c[source.key] ?? {})))).filter(
    (buffer): buffer is SourceBuffer => buffer !== undefined,
  );
  const entries: Entry[] = [];
  while (entries.length < pageSize) {
    const drained = buffers.filter((buffer) => buffer.queue.length === 0 && buffer.hasMore);
    if (drained.length > 0) {
      const refilled = await Promise.all(drained.map((buffer) => load(buffer.source, { t: buffer.next ?? undefined })));
      buffers = buffers.flatMap((buffer) => {
        const index = drained.indexOf(buffer);
        if (index === -1) return [buffer];
        const next = refilled[index];
        return next === undefined ? [] : [next];
      });
    }
    let best: SourceBuffer | undefined;
    for (const buffer of buffers) {
      const head = buffer.queue[0];
      if (head === undefined) continue;
      if (best === undefined || compare(position(head), position(best.queue[0]!)) < 0) best = buffer;
    }
    if (best === undefined) break;
    const entry = best.queue.shift()!;
    best.consumed = position(entry);
    entries.push(stamp(entry, best.source.hostId, groups));
  }

  const cursors: Record<string, Cursor> = {};
  for (const buffer of buffers) {
    if (buffer.queue.length > 0) {
      cursors[buffer.source.key] = { t: buffer.cursor.t, k: buffer.consumed ?? buffer.cursor.k };
    } else if (buffer.hasMore) {
      cursors[buffer.source.key] = { t: buffer.next ?? undefined };
    } else if (buffer.consumed !== undefined) {
      cursors[buffer.source.key] = { k: buffer.consumed };
    }
  }
  const hasMore = Object.keys(cursors).length > 0;
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return buildPage(groups, entries, total, hasMore, hasMore ? encodeToken({ c: cursors, n: totals }) : null, unavailable);
}

export async function listSessionsAcrossHosts(
  query: V2SessionsListQuery,
  hosts: HostSources,
  local: (query: V2SessionsListQuery) => Promise<V2SessionsListOutcome>,
): Promise<V2SessionsListOutcome> {
  const { hosts: _hosts, ...rest } = query;
  const base: V2SessionsListQuery = rest;
  const groups = base.view === 'by_workspace';
  const projection = (base.fields ?? '').trim().length > 0;
  try {
    const { sources, unavailable } = await collectSources(base, hosts, local);
    const data = projection
      ? await concatenate(base, sources, unavailable, groups)
      : base.page !== undefined
        ? await topPage(base, sources, unavailable, groups)
        : await mergePage(base, sources, unavailable, groups);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof TokenMismatchError) return { ok: false, code: ErrorCode.PAGE_TOKEN_MISMATCH, message: error.message };
    if (error instanceof HostSourceError && error.code !== undefined) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
