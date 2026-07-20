/**
 * Scenario: v1-compatible session routes, including blocked-goal Web resume.
 * Responsibilities: verify HTTP envelopes, persisted reads, and session actions.
 * Wiring: real kap-server; goal-resume cases observe the agent event stream.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/sessions.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IBootstrapService,
  type DomainEvent,
  IAgentGoalService,
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';
import { sessionWarningsResponseSchema } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
  stack?: string;
}

interface SessionWire {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
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

function agentRpc(
  service: ServiceIdentifier<unknown>,
  method: string,
  sessionId: string,
): string {
  return `/api/v1/debug/session/${sessionId}/agent/main/${String(service)}/${method}`;
}

function goalContinuationStarts(events: readonly DomainEvent[]): readonly DomainEvent[] {
  return events.filter(
    (event) =>
      event.type === 'turn.started' &&
      event.origin.kind === 'system_trigger' &&
      event.origin.name === 'goal_continuation',
  );
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
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
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
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('downloads a ZIP with the supplied Web log and cleans up its temporary directory', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const webLog = [
      JSON.stringify({ event: 'websocket.connected', time: 1 }),
      JSON.stringify({ event: 'prompt.submitted', time: 2 }),
    ].join('\n');

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ web_log: webLog }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="kimi-session-${id}.zip"`,
    );
    expect(res.headers.get('content-length')).toBe(String(archive.length));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      sessionId: string;
      webLogPath?: string;
    };
    expect(entries.get('logs/kimi-web.jsonl')?.toString('utf8')).toBe(webLog);
    expect(manifest).toMatchObject({
      sessionId: id,
      webLogPath: 'logs/kimi-web.jsonl',
    });
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('returns the JSON session-not-found envelope instead of a ZIP', async () => {
    const id = 'sess_missing_export';
    const { status, body } = await postJson<null>(`/api/v1/sessions/${id}/export`, {});

    expect(status).toBe(200);
    expect(body.code).toBe(40401);
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('cleans up the temporary archive when the client cancels the download', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const sessionDir = (server as RunningServer).core.accessor
      .get(IBootstrapService)
      .sessionDir(created.body.data.workspace_id, id);
    await writeFile(join(sessionDir, 'cancel-test.bin'), randomBytes(8 * 1024 * 1024));

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: '{}',
    } as never);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    await reader?.cancel();

    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('rejects a Web log larger than 256 KiB in UTF-8', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const { status, body } = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/export`,
      { web_log: '你'.repeat(87_382) },
    );

    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('web_log');
  });

  async function createStoppedGoalRig(status: 'paused' | 'blocked') {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'finish the migration' },
    });
    const session = (server as RunningServer).core.accessor
      .get(ISessionLifecycleService)
      .get(id);
    if (session === undefined) throw new Error('expected a live session');
    const agent = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
    if (agent === undefined) throw new Error('expected a live main agent');

    const eventBus = agent.accessor.get(IEventBus);
    const events: DomainEvent[] = [];
    const subscription = eventBus.subscribe((event) => events.push(event));

    const stopped = await postJson<{ status: string }>(
      agentRpc(IAgentGoalService, status === 'blocked' ? 'markBlocked' : 'pauseGoal', id),
      status === 'blocked' ? { reason: 'need credentials' } : {},
    );
    if (stopped.body.data.status !== status) throw new Error(`expected a ${status} goal`);

    return {
      id,
      eventBus,
      events,
      cancel: async () => {
        subscription.dispose();
        await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
          agent_config: { goal_control: 'cancel' },
        });
      },
    };
  }

  async function createBlockedGoalRig() {
    return createStoppedGoalRig('blocked');
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
    expect(body.data.busy).toBe(false);
    expect(body.data.main_turn_active).toBe(false);
    expect(body.data.pending_interaction).toBe('none');
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

  it('rejects create when metadata.cwd does not exist (40409)', async () => {
    const missing = join(home as string, 'never-created');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: missing } });
    expect(body.code).toBe(40409);

    // The failed create leaves no phantom workspace or session behind.
    const workspaces = await getJson<{ items: unknown[] }>('/api/v1/workspaces');
    expect(workspaces.body.data.items).toEqual([]);
    const sessions = await getJson<PageWire>('/api/v1/sessions');
    expect(sessions.body.data.items).toEqual([]);
  });

  it('rejects create when metadata.cwd is not a directory (40409)', async () => {
    const file = join(home as string, 'a-file.txt');
    await writeFile(file, 'hi', 'utf8');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: file } });
    expect(body.code).toBe(40409);
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

  it('supports exclude_empty when listing sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const all = await getJson<PageWire>('/api/v1/sessions');
    expect(all.body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);

    const filtered = await getJson<PageWire>('/api/v1/sessions?exclude_empty=true');
    expect(filtered.body.code).toBe(0);
    expect(filtered.body.data.items.some((s) => s.id === created.body.data.id)).toBe(false);
  });

  it('paginates sessions with before_id and terminates on the last page', async () => {
    const cwd = home as string;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { body } = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(body.code).toBe(0);
      ids.push(body.data.id);
      await sleep(5); // keep updatedAt strictly increasing so recency order is deterministic
    }

    // Recency order: most-recently-created first → page 1 holds ids[6,5,4].
    const page1 = await getJson<PageWire>('/api/v1/sessions?page_size=3');
    expect(page1.body.code).toBe(0);
    expect(page1.body.data.items.map((s) => s.id)).toEqual(ids.slice(4).reverse());
    expect(page1.body.data.has_more).toBe(true);

    const cursor1 = page1.body.data.items[page1.body.data.items.length - 1]!.id;
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor1)}`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(ids.slice(1, 4).reverse());
    expect(page2.body.data.has_more).toBe(true);

    const cursor2 = page2.body.data.items[page2.body.data.items.length - 1]!.id;
    const page3 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor2)}`,
    );
    expect(page3.body.data.items.map((s) => s.id)).toEqual([ids[0]]);
    expect(page3.body.data.has_more).toBe(false);

    // No overlap across pages, and together they cover every session exactly once.
    const seen = [
      ...page1.body.data.items,
      ...page2.body.data.items,
      ...page3.body.data.items,
    ].map((s) => s.id);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(ids));

    // Paging past the oldest session yields an empty, terminal page — the client
    // must stop here instead of looping (regression for the boot request storm).
    const last = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(ids[0]!)}`,
    );
    expect(last.body.data.items).toEqual([]);
    expect(last.body.data.has_more).toBe(false);
  });

  it('returns an empty terminal page for an unknown before_id cursor', async () => {
    const cwd = home as string;
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>(
      '/api/v1/sessions?page_size=3&before_id=sess_does_not_exist',
    );
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
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
      busy: boolean;
      thinking_level: string;
      plan_mode: boolean;
      context_tokens: number;
    }>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(body.code).toBe(0);
    expect(body.data.busy).toBe(false);
    expect(typeof body.data.thinking_level).toBe('string');
    expect(typeof body.data.plan_mode).toBe('boolean');
    expect(body.data.context_tokens).toBe(0);
  });

  it('reflects plan/swarm/permission agent_config in GET /status', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const before = await getJson<{
      plan_mode: boolean;
      swarm_mode: boolean;
      permission: string;
    }>(`/api/v1/sessions/${id}/status`);
    expect(before.body.data.plan_mode).toBe(false);
    expect(before.body.data.swarm_mode).toBe(false);

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true, swarm_mode: true, permission_mode: 'yolo' },
    });

    const after = await getJson<{
      plan_mode: boolean;
      swarm_mode: boolean;
      permission: string;
    }>(`/api/v1/sessions/${id}/status`);
    expect(after.body.data.plan_mode).toBe(true);
    expect(after.body.data.swarm_mode).toBe(true);
    expect(after.body.data.permission).toBe('yolo');
  });

  it('returns the current goal via GET /goal', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const before = await getJson<unknown>(`/api/v1/sessions/${id}/goal`);
    expect(before.body.data).toBeNull();

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'fix all lint warnings' },
    });

    const after = await getJson<{ objective: string; status: string } | null>(
      `/api/v1/sessions/${id}/goal`,
    );
    expect(after.body.data?.objective).toBe('fix all lint warnings');
    expect(after.body.data?.status).toBe('active');
  });

  it('starts one continuation when the Web profile resumes a blocked goal', async () => {
    const rig = await createBlockedGoalRig();
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('starts one continuation when the Web profile resumes a paused goal', async () => {
    const rig = await createStoppedGoalRig('paused');
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('returns the active goal when the Web refreshes after blocked-goal resume', async () => {
    const rig = await createBlockedGoalRig();
    try {
      rig.eventBus.publish({ type: 'turn.started', turnId: 999, origin: { kind: 'user' } });
      await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      const refreshed = await getJson<{ status: string } | null>(
        `/api/v1/sessions/${rig.id}/goal`,
      );

      expect(refreshed.body.data?.status).toBe('active');
    } finally {
      await rig.cancel();
    }
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

  it('restores an archived session via :restore and returns it to the default list', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);

    const restored = await postJson<SessionWire>(`/api/v1/sessions/${id}:restore`);
    expect(restored.body.code).toBe(0);
    expect(restored.body.data.id).toBe(id);
    expect(restored.body.data.archived).toBe(false);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.find((s) => s.id === id)?.archived).toBe(false);
  });

  it('returns 40401 when restoring a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing:restore');
    expect(body.code).toBe(40401);
  });

  it('cold-loads a persisted session on :undo instead of 40401', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    // Drop the live handle so the session is persisted-but-cold (index + disk
    // only) — the state right after opening a session in the web UI before any
    // prompt has been sent. Before the fix, `:undo` resolved the main agent via
    // `lifecycle.get` (memory only) and reported 40401 "session does not exist".
    await (server as RunningServer).core.accessor.get(ISessionLifecycleService).close(id);

    const res = await postJson<{ messages: unknown }>(`/api/v1/sessions/${id}:undo`, { count: 1 });
    // Cold-loaded successfully: the empty history yields "nothing to undo"
    // (40911), not the pre-fix "session does not exist" (40401).
    expect(res.body.code).toBe(40911);
    expect(res.body.msg).toMatch(/nothing to undo/i);
    // The thrown Error2's stack is surfaced so operators can locate the
    // source — the precheck/throw now lives in the native prompt service.
    expect(res.body.stack).toEqual(expect.stringContaining('promptService'));
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
    // Lock the wire shape to the shared protocol schema (schema-fidelity rule):
    // a mirror route must keep the v1 envelope byte-compatible.
    expect(sessionWarningsResponseSchema.parse(body.data)).toEqual({ warnings: [] });
  });

  it('returns 40401 for warnings of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_warnings/warnings');
    expect(body.code).toBe(40401);
  });

  it('lists only archived sessions with archived_only', async () => {
    const cwd = home as string;
    const a = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const b = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(a.body.code).toBe(0);
    expect(b.body.code).toBe(0);
    const archivedId = a.body.data.id;
    const liveId = b.body.data.id;

    const archived = await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedId}:archive`,
    );
    expect(archived.body.code).toBe(0);

    // Default list hides archived sessions.
    const normal = await getJson<PageWire>('/api/v1/sessions');
    expect(normal.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(normal.body.data.items.some((s) => s.id === archivedId)).toBe(false);

    // archived_only shows only the archived one.
    const onlyArchived = await getJson<PageWire>('/api/v1/sessions?archived_only=true');
    expect(onlyArchived.body.code).toBe(0);
    expect(onlyArchived.body.data.items.some((s) => s.id === archivedId)).toBe(true);
    expect(onlyArchived.body.data.items.some((s) => s.id === liveId)).toBe(false);

    // include_archive shows both.
    const all = await getJson<PageWire>('/api/v1/sessions?include_archive=true');
    expect(all.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(all.body.data.items.some((s) => s.id === archivedId)).toBe(true);
  });

  it('paginates archived_only without returning empty filtered pages', async () => {
    const cwd = home as string;
    const archivedOlder = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedOlder.body.data.id}:archive`,
    );

    const archivedNewer = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedNewer.body.data.id}:archive`,
    );

    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const first = await getJson<PageWire>('/api/v1/sessions?archived_only=true&page_size=1');
    expect(first.body.code).toBe(0);
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.items[0]).toMatchObject({
      id: archivedNewer.body.data.id,
      archived: true,
    });
    expect(first.body.data.has_more).toBe(true);

    const second = await getJson<PageWire>(
      `/api/v1/sessions?archived_only=true&page_size=1&before_id=${archivedNewer.body.data.id}`,
    );
    expect(second.body.code).toBe(0);
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]).toMatchObject({
      id: archivedOlder.body.data.id,
      archived: true,
    });
    expect(second.body.data.has_more).toBe(false);
  });

  it('rejects archived_only combined with include_archive (40001)', async () => {
    const { body } = await getJson<null>(
      '/api/v1/sessions?archived_only=true&include_archive=true',
    );
    expect(body.code).toBe(40001);
  });

  it('returns a terminal empty page when archived_only busy filtering finds no match', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const second = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${first.body.data.id}:archive`);
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${second.body.data.id}:archive`);

    const page = await getJson<PageWire>(
      '/api/v1/sessions?archived_only=true&busy=true&page_size=1',
    );
    expect(page.body.code).toBe(0);
    expect(page.body.data).toEqual({ items: [], has_more: false });
  });

  it('rejects a malformed workspace_id when listing (40001)', async () => {
    const { body } = await getJson<null>('/api/v1/sessions?workspace_id=not-a-workspace-id');
    expect(body.code).toBe(40001);
  });

  it('returns 40410 for an unknown workspace_id when listing', async () => {
    const { body } = await getJson<null>('/api/v1/sessions?workspace_id=wd_missing_000000000000');
    expect(body.code).toBe(40410);
  });

  it('lists the union of legacy split buckets for one workspace, in recency order', async () => {
    // Legacy pre-fold data: one physical directory registered under two
    // spelling variants, with sessions bucketed per minted id.
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const lowerId = encodeWorkDirKey(lowerRoot);
    await writeFile(
      join(home as string, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [typedId]: {
            root: typedRoot,
            name: 'proj',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
          [lowerId]: {
            root: lowerRoot,
            name: 'proj',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    const seedBucket = async (wsId: string, sid: string, updatedAt: number): Promise<void> => {
      const dir = join(home as string, 'sessions', wsId, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'state.json'),
        JSON.stringify({ version: 2, cwd: typedRoot, createdAt: 1, updatedAt }),
        'utf8',
      );
    };
    await seedBucket(typedId, 's-typed', 50);
    await seedBucket(lowerId, 's-lower', 60);

    // The registry merges the two entries; whichever id survives is the
    // representative the client lists by.
    const workspaces = await getJson<{ items: { id: string }[] }>('/api/v1/workspaces');
    const rep = workspaces.body.data.items[0]?.id as string;
    expect([typedId, lowerId]).toContain(rep);

    const listed = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.map((s) => s.id)).toEqual(['s-lower', 's-typed']);

    // Id-cursor pagination spans the bucket boundary without repeats.
    const page1 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1`,
    );
    expect(page1.body.data.items.map((s) => s.id)).toEqual(['s-lower']);
    expect(page1.body.data.has_more).toBe(true);
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1&before_id=s-lower`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(['s-typed']);
    expect(page2.body.data.has_more).toBe(false);
  });

  it('filters listed sessions by the busy query (post-page, like v1)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    // A freshly-created session has no work, so it is not busy — the wire
    // fact is the resolved drain-registry read, not a constant placeholder.
    expect(created.body.data.busy).toBe(false);

    const idle = await getJson<PageWire>('/api/v1/sessions?busy=false');
    expect(idle.body.code).toBe(0);
    expect(idle.body.data.items.some((s) => s.id === id)).toBe(true);

    const running = await getJson<PageWire>('/api/v1/sessions?busy=true');
    expect(running.body.code).toBe(0);
    expect(running.body.data.items.some((s) => s.id === id)).toBe(false);
  });

  it('filters child sessions by the busy query', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {});
    const childId = child.body.data.id;
    expect(child.body.data.busy).toBe(false);

    const idle = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children?busy=false`);
    expect(idle.body.code).toBe(0);
    expect(idle.body.data.items.some((s) => s.id === childId)).toBe(true);

    const running = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children?busy=true`);
    expect(running.body.code).toBe(0);
    expect(running.body.data.items.some((s) => s.id === childId)).toBe(false);
  });

  it('keeps a session listable and gettable with cwd after its workspace is unregistered (gap G3)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'g3',
      metadata: { cwd },
    });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;

    // Unregister the workspace without removing on-disk content. The session
    // persists its frozen cwd, so it must remain listable / gettable with the
    // original cwd instead of being filtered (list) or 404 (get/profile).
    const del = await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${workspaceId}`);
    expect(del.body.code).toBe(0);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    const found = listed.body.data.items.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.metadata.cwd).toBe(cwd);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.metadata.cwd).toBe(cwd);

    const profile = await getJson<SessionWire>(`/api/v1/sessions/${id}/profile`);
    expect(profile.body.code).toBe(0);
    expect(profile.body.data.metadata.cwd).toBe(cwd);
  });

  it('merges metadata via profile and keeps cwd authoritative', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { foo: 'bar' },
    });
    expect(first.body.code).toBe(0);
    expect(first.body.data.metadata['foo']).toBe('bar');
    expect(first.body.data.metadata.cwd).toBe(cwd);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.metadata['foo']).toBe('bar');
    expect(got.body.data.metadata.cwd).toBe(cwd);
  });

  it('replaces custom metadata on a second profile update (v1 semantics)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, { metadata: { foo: 'bar' } });
    const second = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { baz: 1 },
    });
    expect(second.body.code).toBe(0);
    // v1 writes the patch straight into `custom` (replace, not deep-merge): the
    // first key is gone, the new key is present, and cwd still wins.
    expect(second.body.data.metadata['foo']).toBeUndefined();
    expect(second.body.data.metadata['baz']).toBe(1);
    expect(second.body.data.metadata.cwd).toBe(cwd);
  });

  it('applies agent_config.permission_mode via profile idempotently', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(first.body.code).toBe(0);

    // Re-applying the same mode must not error (the setter is idempotent).
    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(again.body.code).toBe(0);
  });

  it('guards agent_config.plan_mode so a repeated true does not re-enter', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(first.body.code).toBe(0);

    // Without the diff-guard this second enter would throw 'Already in plan mode'
    // and surface as a non-zero code.
    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(again.body.code).toBe(0);
  });

  it('maps goal already_exists from agent_config.goal_objective (40913)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(first.body.code).toBe(0);

    const dup = await postJson<null>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(dup.body.code).toBe(40913);
  });

  it('publishes session.meta.updated on the core bus when renaming via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed-via-profile',
    });
    expect(updated.body.code).toBe(0);
    sub.dispose();

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('renamed-via-profile');
  });

  it('returns 40401 when updating the profile of a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing_profile/profile', {
      title: 'nope',
    });
    expect(body.code).toBe(40401);
  });

  it('derives the session title from the first prompt submitted via /api/v1', async () => {
    const cwd = home as string;
    await writeFile(join(cwd, 'config.toml'), [
      'default_model = "stub"', '', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "stub"', '',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000', '',
    ].join('\n'), 'utf-8');
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.title).toBe('');

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));

    const submitted = await postJson<{ prompt_id: string; status: string }>(
      `/api/v1/sessions/${id}/prompts`,
      { content: [{ type: 'text', text: 'hello web title' }] },
    );
    expect(submitted.body.code).toBe(0);
    sub.dispose();

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.title).toBe('hello web title');

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('hello web title');
  });
});

async function listExportTempDirs(sessionId: string): Promise<string[]> {
  const prefix = `kimi-session-export-${sessionId}-`;
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).toSorted();
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record not found');

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${method}`);

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('server-v2 /api/v1/sessions status context window', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-status-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "k2"',
        '',
        '[providers.kimi]',
        'type = "kimi"',
        'api_key = "sk-test"',
        'base_url = "https://api.example.test/v1"',
        '',
        '[models.k2]',
        'provider = "kimi"',
        'model = "kimi-k2"',
        'max_context_size = 131072',
        'display_name = "Kimi K2"',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
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
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('reports the default model context window before any model is bound', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<{
      status: string;
      model?: string;
      context_tokens: number;
      max_context_tokens: number;
      context_usage: number;
    }>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(body.code).toBe(0);
    // No model is bound to the lazily-created main agent yet, but the status
    // line should still show the configured default model's context window
    // instead of 0 (mirrors v1, which binds the default model at creation).
    expect(body.data.max_context_tokens).toBe(131072);
    expect(body.data.context_tokens).toBe(0);
    expect(body.data.context_usage).toBe(0);
  });
});
