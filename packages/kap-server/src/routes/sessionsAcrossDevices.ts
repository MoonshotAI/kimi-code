import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ErrorCode } from '../protocol/error-codes';
import type {
  ListSessionsFlatResponse,
  ListSessionsGroupedResponse,
  ListSessionsQuery,
  SessionsSort,
} from '../protocol/rest-session';
import type { Session } from '../protocol/session';
import {
  DeviceSourceError,
  deviceGet,
  deviceProjects,
  type DeviceSources,
} from '../services/devices/deviceFanout';
import {
  compareSessionGroups,
  compareSessionPositions,
  sessionPositionOf,
  type SessionPosition,
} from './sessionOrder';

export type SessionsPage = ListSessionsFlatResponse | ListSessionsGroupedResponse;
export type SessionsListOutcome =
  | { readonly ok: true; readonly data: SessionsPage }
  | { readonly ok: false; readonly code: number; readonly message: string };

type Page = SessionsPage;
type Entry = Record<string, unknown>;
type Query = Omit<ListSessionsQuery, 'devices'>;

interface Source {
  readonly key: string;
  readonly deviceId?: string;
  readonly workspaceIds?: string[];
  fetch(query: Query): Promise<Page>;
  total?: number;
}

interface Buffer {
  readonly source: Source;
  token?: string;
  queue: Entry[];
  next?: string;
}

interface Context {
  readonly query: Query;
  readonly groups: boolean;
  readonly projection: boolean;
  readonly position: (entry: Entry) => SessionPosition;
  readonly compare: (a: SessionPosition, b: SessionPosition) => number;
  unavailable: string[];
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

function decodeToken(raw: string, context: Context, deviceIds: readonly string[]): MergeToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new TokenMismatchError('page_token is corrupted; discard it and restart from the first page');
  }
  const result = mergeTokenSchema.safeParse(parsed);
  if (!result.success || result.data.q !== fingerprint(context.query) || result.data.h.join('\0') !== deviceIds.join('\0')) {
    throw new TokenMismatchError('page_token does not match this query and device set; discard it and restart from the first page');
  }
  return result.data;
}

function isGroups(page: Page): page is ListSessionsGroupedResponse {
  return 'groups' in page;
}

async function collectSources(
  query: Query,
  devices: DeviceSources,
  local: (query: Query) => Promise<SessionsListOutcome>,
  unavailable: string[],
): Promise<{ sources: Source[]; deviceIds: string[] }> {
  const filter = query.workspace_id === undefined ? undefined : new Set([query.workspace_id].flat());
  const configured = devices.sources();
  const remote = await Promise.all(configured.map(async (device): Promise<Source | undefined> => {
    const session = await device.getSession();
    if (session === undefined) {
      unavailable.push(device.id);
      return undefined;
    }
    let projectIds: string[];
    try {
      projectIds = (await deviceProjects<{ id: string; kind: string }>(session)).map((project) => project.id);
    } catch (error) {
      if (error instanceof DeviceSourceError && error.code !== undefined) throw error;
      unavailable.push(device.id);
      return undefined;
    }
    const allowed = filter === undefined ? projectIds : projectIds.filter((id) => filter.has(id));
    if (allowed.length === 0) return undefined;
    return {
      key: device.id,
      deviceId: device.id,
      workspaceIds: allowed,
      fetch: (next) => deviceGet<Page>(session, '/api/v1/sessions', next),
    };
  }));
  return {
    sources: [{
      key: '',
      fetch: (nextQuery) => local(nextQuery).then((outcome) => outcome.ok ? outcome.data : Promise.reject(new DeviceSourceError(outcome.code, outcome.message))),
    }, ...remote.filter((source): source is Source => source !== undefined)],
    deviceIds: ['', ...configured.map((device) => device.id)],
  };
}

function project(entry: Entry, groups: boolean, deviceId: string | undefined): Entry {
  const sessions = groups ? (entry['sessions'] as Entry[]) : [entry];
  const ids = sessions.map((session) => ({
    id: session['id'],
    archived: session['archived'],
    device_id: deviceId,
  }));
  return groups ? { ...entry, sessions: ids } : ids[0]!;
}

async function stamp(entry: Entry, context: Context, source: Source): Promise<Entry> {
  const deviceId = source.deviceId;
  if (context.projection) {
    if (context.groups && (context.query.group_page_size ?? 5) > SOURCE_PAGE_SIZE_MAX) {
      const page = await source.fetch({
        ...context.query,
        view: 'flat',
        workspace_id: entry['workspace_id'] as string,
        group_page_size: undefined,
        page: undefined,
        page_token: undefined,
        page_size: context.query.group_page_size,
      }) as ListSessionsFlatResponse;
      entry = { ...entry, sessions: page.items };
    }
    return project(entry, context.groups, deviceId);
  }
  if (deviceId === undefined) return entry;
  if (!context.groups) return { ...entry, device_id: deviceId };
  return {
    ...entry,
    sessions: (entry['sessions'] as Entry[]).map((session) => ({ ...session, device_id: deviceId })),
    device_id: deviceId,
  };
}

async function load(source: Source, context: Context, token?: string, after?: SessionPosition): Promise<Buffer> {
  const seen = new Set<string>();
  const groupPageSize = context.query.group_page_size;
  for (;;) {
    let page: Page;
    try {
      page = await source.fetch({
        ...context.query,
        fields: undefined,
        page: undefined,
        page_token: token,
        page_size: Math.min(context.query.page_size ?? 50, SOURCE_PAGE_SIZE_MAX),
        group_page_size: groupPageSize !== undefined && groupPageSize > SOURCE_PAGE_SIZE_MAX ? 1 : groupPageSize,
        workspace_id: source.workspaceIds ?? context.query.workspace_id,
      });
    } catch (error) {
      if (source.deviceId !== undefined && !(error instanceof DeviceSourceError && error.code !== undefined)) {
        if (context.query.page_token === undefined) {
          context.unavailable.push(source.deviceId);
          return { source, token, queue: [] };
        }
        throw new DeviceSourceError(ErrorCode.DEVICE_UNAVAILABLE, `device "${source.deviceId}" is unavailable`);
      }
      throw error;
    }
    const queue = (isGroups(page) ? page.groups : page.items).filter((entry) =>
      after === undefined || context.compare(context.position(entry), after) > 0,
    );
    source.total = page.total;
    if (queue.length > 0 || page.next_page_token === undefined) return { source, token, queue, next: page.next_page_token };
    if (page.next_page_token === token || seen.has(page.next_page_token)) {
      throw new Error(`session listing returned a repeated cursor for device "${source.deviceId ?? 'local'}"`);
    }
    seen.add(page.next_page_token);
    token = page.next_page_token;
  }
}

async function mergePage(
  context: Context,
  sources: Source[],
  deviceIds: readonly string[],
): Promise<Page> {
  const token = context.query.page_token ? decodeToken(context.query.page_token, context, deviceIds) : undefined;
  const active = token === undefined ? sources : sources.filter((source) => token.c[source.key] !== undefined);
  const buffers = await Promise.all(active.map((source) => load(source, context, token?.c[source.key]?.t, token?.a ?? token?.c[source.key]?.k)));
  const entries: Entry[] = [];
  const emitted = new Map<string, SessionPosition>();
  let after: SessionPosition | undefined;
  while (entries.length < (context.query.page_size ?? 50)) {
    await Promise.all(buffers.filter((buffer) => buffer.queue.length === 0 && buffer.next !== undefined)
      .map(async (buffer) => {
        const next = await load(buffer.source, context, buffer.next, token?.a ?? emitted.get(buffer.source.key));
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
    buffer.queue.length > 0 || buffer.next !== undefined
      ? [[buffer.source.key, { t: buffer.token, k: emitted.get(buffer.source.key) }]]
      : emitted.has(buffer.source.key)
        ? [[buffer.source.key, { k: emitted.get(buffer.source.key) }]]
        : [],
  ));
  const hasMore = buffers.some((buffer) => buffer.queue.length > 0 || buffer.next !== undefined);
  const total = sources.reduce((sum, source) => sum + (source.total ?? 0), 0);
  for (const buffer of buffers) buffer.queue = [];
  const nextToken = hasMore ? Buffer.from(JSON.stringify({ v: 2, q: fingerprint(context.query), h: [...deviceIds], a: after as SessionPosition, c: cursors } satisfies MergeToken)).toString('base64url') : undefined;
  const unavailable = [...new Set(context.unavailable)].toSorted();
  const base = { total, has_more: hasMore, next_page_token: nextToken, unavailable_devices: unavailable };
  return (context.groups ? { ...base, groups: entries } : { ...base, items: entries }) as Page;
}

function contextFor(query: Query): Context {
  const groups = query.view === 'by_workspace';
  const sort: SessionsSort = query.sort ?? 'updated_at_desc';
  return {
    query,
    groups,
    projection: (query.fields ?? '').trim().length > 0,
    position: (entry) => sessionPositionOf(groups, sort, entry),
    compare: groups
      ? (a, b) => compareSessionGroups(sort, a, b)
      : (a, b) => compareSessionPositions(sort, a, b),
    unavailable: [],
  };
}

function outcomeError(error: unknown): SessionsListOutcome | undefined {
  if (error instanceof TokenMismatchError) return { ok: false, code: ErrorCode.PAGE_TOKEN_MISMATCH, message: error.message };
  if (error instanceof DeviceSourceError && error.code !== undefined) return { ok: false, code: error.code, message: error.message };
  return undefined;
}

export async function listSessionsAcrossDevices(
  query: ListSessionsQuery,
  devices: DeviceSources,
  local: (query: Query) => Promise<SessionsListOutcome>,
): Promise<SessionsListOutcome> {
  const { devices: _devices, ...base } = query;
  if (base.archived_only === true) base.archived = 'true';
  if (base.include_archive === true) base.archived = 'all';
  if (base.exclude_empty === true) base.has_prompt = true;
  const context = contextFor(base);
  try {
    const { sources, deviceIds } = await collectSources(base, devices, local, context.unavailable);
    let data: Page;
    if (context.query.page === undefined || context.query.page === 1) {
      data = await mergePage(context, sources, deviceIds);
    } else {
      const page = context.query.page;
      let token: string | undefined;
      for (let index = 1; index < page; index++) {
        const previous = await mergePage({ ...context, query: { ...context.query, page_token: token } }, sources, deviceIds);
        token = previous.next_page_token;
        if (token === undefined) return { ok: true, data: { ...previous, has_more: false, next_page_token: undefined } };
      }
      data = await mergePage({ ...context, query: { ...context.query, page_token: token } }, sources, deviceIds);
      data.next_page_token = undefined;
    }
    return { ok: true, data };
  } catch (error) {
    const outcome = outcomeError(error);
    if (outcome !== undefined) return outcome;
    throw error;
  }
}

export async function listAllSessionsAcrossDevices(
  query: Query,
  devices: DeviceSources,
  local: (query: Query) => Promise<SessionsListOutcome>,
): Promise<SessionsListOutcome> {
  const context = contextFor({ ...query, fields: undefined });
  try {
    const { sources } = await collectSources(context.query, devices, local, context.unavailable);
    const items: Session[] = [];
    for (const source of sources) {
      let buffer = await load(source, context);
      for (;;) {
        items.push(...await Promise.all(buffer.queue.map((entry) => stamp(entry, context, source) as Promise<Session>)));
        if (buffer.next === undefined) break;
        buffer = await load(source, context, buffer.next);
      }
    }
    items.sort((a, b) => context.compare(context.position(a), context.position(b)));
    return {
      ok: true,
      data: {
        items: query.fields === undefined
          ? items
          : items.map((item) => project(item, false, item.device_id) as Session),
        total: items.length,
        has_more: false,
        unavailable_devices: [...new Set(context.unavailable)].toSorted(),
      },
    };
  } catch (error) {
    const outcome = outcomeError(error);
    if (outcome !== undefined) return outcome;
    throw error;
  }
}
