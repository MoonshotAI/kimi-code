import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IWireService,
  ISessionLifecycleService,
  IModelCatalog,
  type ContextMessage,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface MessageWire {
  id: string;
  session_id: string;
  role: string;
  content: { type: string; [key: string]: unknown }[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface PageWire {
  items: MessageWire[];
  has_more: boolean;
}

const MSG_ID = /^msg_.+/;

describe('server-v2 /api/v1/sessions/{sid}/messages', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let seeds: ScopeSeed | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-messages-'));
    // Seed a stub IModelCatalog so the agent scope can instantiate if a
    // transitive service needs it; IContextMemory itself does not.
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
      inspect: () => {
        throw new Error('modelCatalog.inspect not exercised in this test');
      },
      ping: () => {
        throw new Error('modelCatalog.ping not exercised in this test');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('modelCatalog.getProvider not exercised in this test');
      },
      setDefaultModel: async () => {
        throw new Error('modelCatalog.setDefaultModel not exercised in this test');
      },
    };
    seeds = [[IModelCatalog, modelCatalog]];
    await boot();
  });

  async function boot(): Promise<void> {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

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

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here, then append messages directly into
  // its IContextMemory to bypass the LLM loop.
  async function seedMainAgentMessages(
    sessionId: string,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    let agent = session.accessor.get(IAgentLifecycleService).get('main');
    if (agent === undefined) {
      agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    }
    if (messages.length > 0) {
      agent.accessor.get(IAgentContextMemoryService).append(...messages);
      // Flush the wire log so the temp home is quiescent before afterEach rm's
      // it (macOS can ENOTEMPTY an rmdir while an append is still in flight).
      await agent.accessor.get(IWireService).flush();
    }
  }

  it('returns an empty page when the session has no main agent', async () => {
    const id = await createSession();
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('returns an empty page when the main agent has no messages yet', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, []);
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('lists spliced messages newest-first with stable ids and mapped content', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'file.txt' }], toolCalls: [], toolCallId: 'call_1' },
    ]);

    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.has_more).toBe(false);
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items.every((m) => MSG_ID.test(m.id))).toBe(true);
    expect(body.data.items.every((m) => m.session_id === id)).toBe(true);

    // newest first → tool, assistant, user.
    const [tool, assistant, user] = body.data.items;

    expect(user).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });

    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        {
          type: 'tool_use',
          tool_call_id: 'call_1',
          tool_name: 'Bash',
          input: { cmd: 'ls' },
        },
      ],
    });

    expect(tool).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool_result', tool_call_id: 'call_1', output: 'file.txt' }],
    });
  });

  it('gets a single message by id and 404s for an unknown message', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
    ]);

    const list = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    const assistant = list.body.data.items.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();

    const got = await getJson<MessageWire>(
      `/api/v1/sessions/${id}/messages/${assistant!.id}`,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data).toMatchObject({
      id: assistant!.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });

    const missing = await getJson<null>(
      `/api/v1/sessions/${id}/messages/msg_does_not_exist`,
    );
    expect(missing.body.code).toBe(40403);
  });

  it('returns 40403 for a message id not present in the session', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    const { body } = await getJson<null>(
      `/api/v1/sessions/${id}/messages/msg_00NOT_IN_SESSION00`,
    );
    expect(body.code).toBe(40403);
  });

  it('returns 40401 for an unknown session on both endpoints', async () => {
    const list = await getJson<null>('/api/v1/sessions/nope/messages');
    expect(list.body.code).toBe(40401);

    const got = await getJson<null>('/api/v1/sessions/nope/messages/msg_does_not_exist');
    expect(got.body.code).toBe(40401);
  });

  it('paginates with page_size and before_id / after_id cursors', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'm0' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'm1' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'm2' }], toolCalls: [] },
    ]);
    const all = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?page_size=100`);
    // newest first → [m2, m1, m0]
    const idsDesc = all.body.data.items.map((m) => m.id);
    expect(idsDesc).toHaveLength(3);

    // page_size=1 → newest only, more available.
    const first = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?page_size=1`);
    expect(first.body.data.items.map((m) => m.id)).toEqual([idsDesc[0]]);
    expect(first.body.data.has_more).toBe(true);

    // before_id = newest → the two older entries.
    const older = await getJson<PageWire>(
      `/api/v1/sessions/${id}/messages?before_id=${idsDesc[0]}`,
    );
    expect(older.body.data.items.map((m) => m.id)).toEqual([idsDesc[1], idsDesc[2]]);
    expect(older.body.data.has_more).toBe(false);

    // after_id = oldest → the two newer entries.
    const newer = await getJson<PageWire>(
      `/api/v1/sessions/${id}/messages?after_id=${idsDesc[2]}`,
    );
    expect(newer.body.data.items.map((m) => m.id)).toEqual([idsDesc[0], idsDesc[1]]);
    expect(newer.body.data.has_more).toBe(false);
  });

  it('filters the page by role after pagination', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'q' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }], toolCalls: [] },
    ]);
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?role=user`);
    expect(body.code).toBe(0);
    expect(body.data.items.every((m) => m.role === 'user')).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items.every((m) => MSG_ID.test(m.id))).toBe(true);
  });

  // Regression for the cold-session gap: a persisted (non-live) session must
  // return its full wire transcript — including the pre-compaction prefix —
  // instead of an empty page / 40403. We seed the wire log through the live
  // agent (append + a compaction fold + flush), then restart the whole server
  // on the same home so the session is genuinely cold on the read path.
  it('reads the persisted full transcript for a cold session', async () => {
    const id = await createSession();
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const ctx = agent.accessor.get(IAgentContextMemoryService);
    // Three messages, then a compaction that folds the prefix into a summary.
    ctx.append(
      { role: 'user', content: [{ type: 'text', text: 'm0' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'm1' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'm2' }], toolCalls: [] },
    );
    ctx.applyCompaction({
      summary: 'summary',
      contextSummary: 'summary',
      compactedCount: 3,
      tokensBefore: 100,
    });
    await agent.accessor.get(IWireService).flush();

    // The live read already serves the full transcript (pre-compaction prefix
    // + summary), matching v1's `/messages`. Capture the summary id so we can
    // assert it survives the restart unchanged.
    const livePage = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?page_size=100`);
    expect(livePage.body.data.items).toHaveLength(4);
    const liveSummaryId = livePage.body.data.items[0]!.id;

    // Restart the server on the same homeDir → the session is cold for the next
    // read (mirrors a session carried over from a prior process).
    await server!.close();
    server = undefined;
    await boot();

    // Full transcript preserved (pre-compaction m0/m1/m2 + summary), newest first.
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?page_size=100`);
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(4);
    expect(body.data.items.every((m) => MSG_ID.test(m.id))).toBe(true);

    // newest first → summary, m2, m1, m0.
    const [summary, _m2, maybeM1] = body.data.items;
    if (maybeM1 === undefined) throw new Error('expected m1 message');
    const m1 = maybeM1;
    // The summary id derivation is stable across live reads and restore.
    expect(summary!.id).toBe(liveSummaryId);
    expect(summary).toMatchObject({
      role: 'user',
      metadata: { origin: { kind: 'compaction_summary' } },
    });

    // get returns a specific message for a cold session …
    const got = await getJson<MessageWire>(`/api/v1/sessions/${id}/messages/${m1.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data).toMatchObject({
      id: m1.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'm1' }],
    });

    // … and 40403 for an unknown message id in the same cold session.
    const missing = await getJson<null>(`/api/v1/sessions/${id}/messages/msg_does_not_exist`);
    expect(missing.body.code).toBe(40403);
  });
});
