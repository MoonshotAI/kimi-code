import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface SessionWire {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: string;
  archived?: boolean;
  metadata: { cwd: string } & Record<string, unknown>;
  agent_config: { model: string };
  usage: { input_tokens: number };
  permission_rules: unknown[];
  message_count: number;
  last_seq: number;
}

interface PageWire {
  items: SessionWire[];
  has_more: boolean;
}

describe('server-v2 /api/v1/sessions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('creates a session from metadata.cwd', async () => {
    const cwd = home as string;
    const { status, body } = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'hello',
      metadata: { cwd },
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.data.id).toBe('string');
    expect(typeof body.data.workspace_id).toBe('string');
    expect(body.data.title).toBe('hello');
    expect(body.data.metadata.cwd).toBe(cwd);
    expect(body.data.status).toBe('idle');
    expect(body.data.agent_config).toEqual({ model: '' });
    expect(body.data.permission_rules).toEqual([]);
    expect(body.data.message_count).toBe(0);
    expect(body.data.last_seq).toBe(0);
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
  });

  it('rejects create without cwd or workspace_id (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', { title: 'no cwd' });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  it('rejects create with unknown workspace_id (40410)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: 'wd_missing_000000000000',
      metadata: { cwd: '/x' },
    });
    expect(body.code).toBe(40410);
  });

  it('creates a second session via workspace_id resolved from a prior cwd create', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(first.body.code).toBe(0);

    const second = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd },
    });
    expect(second.body.code).toBe(0);
    expect(second.body.data.workspace_id).toBe(first.body.data.workspace_id);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('rejects create when cwd mismatches workspace root (40001)', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd: '/definitely/elsewhere' },
    });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  it('lists created sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>('/api/v1/sessions');
    expect(body.code).toBe(0);
    expect(body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);
    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('gets a session by id and 404s for unknown', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.id).toBe(created.body.data.id);

    const missing = await getJson<null>('/api/v1/sessions/nope');
    expect(missing.body.code).toBe(40401);
  });

  it('updates the session title via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed',
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.title).toBe('renamed');

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.title).toBe('renamed');
  });

  it('returns best-effort status for a live session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<{
      status: string;
      thinking_level: string;
      plan_mode: boolean;
      context_tokens: number;
    }>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(body.code).toBe(0);
    expect(['idle', 'running', 'awaiting_approval', 'awaiting_question']).toContain(
      body.data.status,
    );
    expect(typeof body.data.thinking_level).toBe('string');
    expect(typeof body.data.plan_mode).toBe('boolean');
    expect(body.data.context_tokens).toBe(0);
  });

  it('archives a session via :archive and reflects archived flag on get', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    expect(archived.body.code).toBe(0);
    expect(archived.body.data).toEqual({ archived: true });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.archived).toBe(true);
  });

  it('rejects an unsupported action suffix (40001)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await postJson<null>(`/api/v1/sessions/${created.body.data.id}:restart`);
    expect(body.code).toBe(40001);
  });

  it('creates a child session tagged with parent_session_id and child_session_kind', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(parent.body.code).toBe(0);
    const parentId = parent.body.data.id;

    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {
      title: 'child-title',
      metadata: { branch: 'direct-child' },
    });
    expect(child.status).toBe(200);
    expect(child.body.code).toBe(0);
    expect(child.body.data.id).not.toBe(parentId);
    expect(child.body.data.title).toBe('child-title');
    expect(child.body.data.metadata['parent_session_id']).toBe(parentId);
    expect(child.body.data.metadata['child_session_kind']).toBe('child');
    // caller-supplied metadata is preserved alongside the markers, and cwd wins.
    expect(child.body.data.metadata['branch']).toBe('direct-child');
    expect(child.body.data.metadata.cwd).toBe(cwd);
  });

  it('defaults the child title to "Child: <parent title>"', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'parent-title',
      metadata: { cwd },
    });
    const child = await postJson<SessionWire>(
      `/api/v1/sessions/${parent.body.data.id}/children`,
      {},
    );
    expect(child.body.code).toBe(0);
    expect(child.body.data.title).toBe('Child: parent-title');
  });

  it('lists direct children and omits grandchildren', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {
      metadata: { branch: 'child' },
    });
    const childId = child.body.data.id;
    const grandchild = await postJson<SessionWire>(`/api/v1/sessions/${childId}/children`, {
      metadata: { branch: 'grandchild' },
    });
    const grandchildId = grandchild.body.data.id;

    const parentChildren = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(parentChildren.body.code).toBe(0);
    expect(parentChildren.body.data.items.some((s) => s.id === childId)).toBe(true);
    expect(parentChildren.body.data.items.some((s) => s.id === grandchildId)).toBe(false);

    const childChildren = await getJson<PageWire>(`/api/v1/sessions/${childId}/children`);
    expect(childChildren.body.code).toBe(0);
    expect(childChildren.body.data.items.some((s) => s.id === grandchildId)).toBe(true);
  });

  it('does not list a plain fork as a child (kind must be "child")', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);

    const children = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(children.body.code).toBe(0);
    expect(children.body.data.items.some((s) => s.id === forked.body.data.id)).toBe(false);
  });

  it('returns 40401 when listing children of a missing parent', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_parent/children');
    expect(body.code).toBe(40401);
  });

  it('returns 40401 when creating a child for a missing parent', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing_parent/children', {});
    expect(body.code).toBe(40401);
  });

  it('returns an empty warnings list for an existing session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { status, body } = await getJson<{ warnings: unknown[] }>(
      `/api/v1/sessions/${created.body.data.id}/warnings`,
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ warnings: [] });
  });

  it('returns 40401 for warnings of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_warnings/warnings');
    expect(body.code).toBe(40401);
  });
});
