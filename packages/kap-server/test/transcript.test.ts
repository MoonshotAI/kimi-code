import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IWireService,
  IEventBus,
  ISessionInteractionService,
  ISessionQuestionService,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
  IModelCatalog,
  type ContextMessage,
  type Event2,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface FrameContract {
  kind: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  interactionKind?: string;
  [key: string]: unknown;
}

interface TurnContract {
  kind: 'turn';
  turnId: string;
  state: string;
  origin?: { kind: string };
  prompt?: string;
  steps: { stepId: string; state: string; frames: FrameContract[] }[];
}

interface TranscriptContract {
  agent_id: string;
  items: (TurnContract | { kind: 'marker' | 'taskref' })[];
  has_more: boolean;
  tasks: unknown[];
  interactions: {
    interactionId: string;
    interactionKind?: string;
    toolCallId?: string;
    state: string;
    [key: string]: unknown;
  }[];
  meta: Record<string, unknown>;
  agents: { agentId: string; type?: string }[];
  pending_interactions: string[];
  seq?: number;
}

interface OpsCatchupContract {
  agent_id: string;
  batches: { seq: number; ops: { op: string }[] }[];
  latest_seq: number;
  complete: boolean;
}

interface UserMessagesContract {
  agents: {
    agent_id: string;
    messages: {
      turn_id: string;
      ordinal: number;
      state: string;
      origin: { kind: string };
      prompt: string;
      attachment_ids?: string[];
      started_at?: string;
    }[];
    attachments: { attachmentId: string; mediaType: string; source?: unknown }[];
  }[];
}

interface PlanEntryContract {
  tool_call_id: string;
  turn_id: string;
  source: 'interaction' | 'display' | 'output';
  plan: string;
  path?: string;
  options?: { label: string; description?: string }[];
  review?: { state: string; selected_option?: string; feedback?: string };
}

interface PlanContract {
  agent_id: string;
  plans: PlanEntryContract[];
}

function serverEvent(payload: Record<string, unknown>): Event2<any> {
  return payload as unknown as Event2<any>;
}

describe('server-v2 /api/v1/sessions/{sid}/transcript', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let seeds: ScopeSeed | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-transcript-'));
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
      hostIdentity: TEST_HOST_IDENTITY,
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
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    if (session.accessor.get(IAgentLifecycleService).get('main') === undefined) {
      await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    }
  }

  function mainAgentBus(sessionId: string): IEventBus {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    return agent!.accessor.get(IEventBus);
  }

  async function seedMainAgentMessages(
    sessionId: string,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    agent!.accessor.get(IAgentContextMemoryService).append(...messages);
    await agent!.accessor.get(IWireService).flush();
  }

  it('streams a live turn tree: deltas flush into full-text frames at step end', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    const empty = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(empty.body.code).toBe(0);
    expect(empty.body.data.items).toEqual([]);
    expect(empty.body.data.has_more).toBe(false);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }));
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        args: { command: 'ls' },
      }),
    );
    bus.publish(serverEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: 'a.txt' }));
    bus.publish(serverEvent({ type: 'turn.step.completed', turnId: 1, step: 1 }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const { body } = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't1',
    );
    expect(turn).toBeDefined();
    expect(turn!.state).toBe('completed');
    expect(turn!.steps).toHaveLength(1);
    const frames = turn!.steps[0]!.frames;
    expect(frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'Hello world' }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        toolCallId: 'call_1',
        state: 'done',
        output: 'a.txt',
      }),
    );
    await vi.waitFor(async () => {
      const again = await getJson<TranscriptContract>(
        `/api/v1/sessions/${id}/transcript?agent_id=main`,
      );
      expect(again.body.data.agents).toContainEqual({ agentId: 'main', type: 'main' });
    });
  });

  it('surfaces approval interactions as global entities with pending ids', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_9',
        name: 'Bash',
        args: {},
      }),
    );

    const session = getLiveSessionById(server!.core.accessor, id);
    const interactions = session!.accessor.get(ISessionInteractionService);
    interactions.enqueue({
      id: 'apr-1',
      kind: 'approval',
      payload: {
        toolCallId: 'call_9',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command', command: 'ls' },
      },
      origin: { agentId: 'main', turnId: 1 },
    });

    let { body } = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(body.data.pending_interactions).toEqual(['apr-1']);
    expect(body.data.interactions).toContainEqual(
      expect.objectContaining({
        interactionId: 'apr-1',
        interactionKind: 'approval',
        toolCallId: 'call_9',
        state: 'pending',
      }),
    );

    interactions.respond('apr-1', { decision: 'approved' });
    ({ body } = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`));
    expect(body.data.pending_interactions).toEqual([]);
    expect(body.data.interactions).toContainEqual(
      expect.objectContaining({ interactionId: 'apr-1', state: 'approved' }),
    );
    const frames = (body.data.items[0] as TurnContract).steps[0]!.frames;
    expect(frames).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_9', approvalId: 'apr-1' }),
    );
  });

  it('paginates live turns with page_size and before_turn', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    for (const turnId of [1, 2, 3]) {
      bus.publish(serverEvent({ type: 'turn.started', turnId, origin: { kind: 'user' } }));
      bus.publish(serverEvent({ type: 'turn.ended', turnId, reason: 'completed' }));
    }

    const page = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main&page_size=2`,
    );
    expect(page.body.data.items.map((item) => (item as TurnContract).turnId)).toEqual(['t2', 't3']);
    expect(page.body.data.has_more).toBe(true);

    const older = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main&page_size=2&before_turn=t3`,
    );
    expect(older.body.data.items.map((item) => (item as TurnContract).turnId)).toEqual(['t1', 't2']);
    expect(older.body.data.has_more).toBe(false);

    const unknown = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=nope`,
    );
    expect(unknown.body.code).toBe(0);
    expect(unknown.body.data.items).toEqual([]);
  });

  it('rebuilds the main agent for a cold session from the wire records', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'file.txt' }],
        toolCalls: [],
        toolCallId: 'call_1',
      },
    ]);

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    expect(body.data.has_more).toBe(false);
    expect(body.data.agents).toEqual([{ agentId: 'main', type: 'main' }]);
    expect(body.data.pending_interactions).toEqual([]);

    const turn = body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.state).toBe('completed');
    expect(turn!.prompt).toBe('hi');
    const frames = turn!.steps[0]!.frames;
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'text', text: 'running' }));
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        toolCallId: 'call_1',
        state: 'done',
        output: 'file.txt',
      }),
    );

    const sub = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(sub.body.code).toBe(0);
    expect(sub.body.data.items).toEqual([]);
    expect(sub.body.data.has_more).toBe(false);
  });

  it('backfills a resumed live session from the wire records, then continues live', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'running' }], toolCalls: [] },
    ]);

    await server!.close();
    server = undefined;
    await boot();
    await resumeSessionById(server!.core.accessor, id);

    const { body } = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.state).toBe('completed');
    expect(turn!.prompt).toBe('hi');

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    const again = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(again.body.data.items.map((item) => (item as TurnContract).turnId)).toEqual(['t0', 't1']);
  });

  it('rebuilds a subagent for a cold session from its own wire records', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
        { role: 'assistant', content: [{ type: 'text', text: 'scanning' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=sub-1`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.prompt).toBe('scan the repo');
    const none = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);
  });

  it('backfills an unmaterialized subagent for a resumed live session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
        { role: 'assistant', content: [{ type: 'text', text: 'scanning' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    await server!.close();
    server = undefined;
    await boot();
    await resumeSessionById(server!.core.accessor, id);
    expect(
      getLiveSessionById(server!.core.accessor, id)!
        .accessor.get(IAgentLifecycleService)
        .get('sub-1'),
    ).toBeUndefined();

    const { body } = await getJson<TranscriptContract>(
      `/api/v1/sessions/${id}/transcript?agent_id=sub-1`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.prompt).toBe('scan the repo');
    expect(body.data.agents).toContainEqual(expect.objectContaining({ agentId: 'sub-1' }));
  });

  it('keeps the metadata-seeded subagent descriptor after an on-demand backfill', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor
      .get(IAgentLifecycleService)
      .create({ agentId: 'sub-1', labels: { parentAgentId: 'main' } });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const { body } = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(body.code).toBe(0);
    expect(body.data.agents).toContainEqual(
      expect.objectContaining({ agentId: 'sub-1', type: 'sub', parentAgentId: 'main' }),
    );
  });

  it('announces a pre-existing pending approval against the backfilled tool frame', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'call_9', name: 'Bash', arguments: '{"command":"ls"}' }],
      },
    ]);

    const session = getLiveSessionById(server!.core.accessor, id);
    session!.accessor.get(ISessionInteractionService).enqueue({
      id: 'apr-1',
      kind: 'approval',
      payload: { toolCallId: 'call_9', toolName: 'Bash', action: 'run' },
      origin: { agentId: 'main', turnId: 0 },
    });

    const { body } = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(body.data.pending_interactions).toEqual(['apr-1']);
    expect(body.data.interactions).toContainEqual(
      expect.objectContaining({
        interactionId: 'apr-1',
        interactionKind: 'approval',
        toolCallId: 'call_9',
        state: 'pending',
      }),
    );

    session!.accessor.get(ISessionInteractionService).respond('apr-1', { decision: 'approved' });
    const after = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const turnAfter = after.body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turnAfter!.steps.flatMap((step) => step.frames)).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_9', approvalId: 'apr-1' }),
    );
  });

  it('does not roster a ghost agent for an unknown agent id on a live session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    const none = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);

    const main = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(main.body.data.agents.map((a) => a.agentId)).not.toContain('nope');
  });

  it('seeds a subagent pending question only after its own backfill', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan' }], toolCalls: [] } as ContextMessage,
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'call_q', name: 'AskUserQuestion', arguments: '{}' }],
        } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    const questions = session!.accessor.get(ISessionQuestionService);
    const pending = questions.request(
      {
        id: 'call_q',
        turnId: 0,
        toolCallId: 'call_q',
        questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
      },
      { agentId: 'sub-1' },
    );

    const mainBody = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(mainBody.body.data.pending_interactions).toEqual([]);

    const subBody = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(subBody.body.data.pending_interactions).toEqual(['call_q']);
    expect(subBody.body.data.interactions).toContainEqual(
      expect.objectContaining({
        interactionId: 'call_q',
        interactionKind: 'question',
        toolCallId: 'call_q',
        state: 'pending',
      }),
    );

    questions.dismiss('call_q');
    await pending;
  });

  it('does not fabricate a roster entry for an unknown agent on a cold session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
    ]);

    await server!.close();
    server = undefined;
    await boot();

    const none = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);
    expect(none.body.data.agents.map((a) => a.agentId)).not.toContain('nope');
    expect(none.body.data.agents).toContainEqual({ agentId: 'main', type: 'main' });
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/nope/transcript?agent_id=main');
    expect(body.code).toBe(40401);
  });

  it('drops the live store when the session closes so reads fall back to the cold rebuild', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }], toolCalls: [] },
    ]);

    const bound = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(bound.body.data.items).toHaveLength(1);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    await closeSessionById(server!.core.accessor, id);

    const { body } = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => (item as TurnContract).turnId)).toEqual(['t0']);
    const turn = body.data.items[0] as TurnContract;
    expect(turn.prompt).toBe('hi');
    expect(turn.steps[0]!.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'hello there' }),
    );
  });

  it('heals the missing stream prefix after a mid-turn attach once the turn ends', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }),
    );
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 0, step: 1 }));
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 0, delta: 'Hello ' }));
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 0, delta: 'world' }));
    const suffix = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const suffixTurn = suffix.body.data.items.find(
      (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(suffixTurn!.steps[0]!.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'world' }),
    );

    await seedMainAgentMessages(id, [
      { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], toolCalls: [] },
    ]);
    bus.publish(serverEvent({ type: 'turn.step.completed', turnId: 0, step: 1 }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

    await vi.waitFor(
      async () => {
        const { body } = await getJson<TranscriptContract>(
          `/api/v1/sessions/${id}/transcript?agent_id=main`,
        );
        const turn = body.data.items.find(
          (item): item is TurnContract => item.kind === 'turn' && item.turnId === 't0',
        );
        expect(turn).toBeDefined();
        expect(turn!.origin).toMatchObject({ kind: 'user' });
        expect(turn!.prompt).toBe('hi');
        expect(turn!.steps[0]!.frames).toContainEqual(
          expect.objectContaining({ kind: 'text', text: 'Hello world' }),
        );
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('routes a subagent question to the subagent transcript, not main', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });

    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const subBus = sub.accessor.get(IEventBus);
    subBus.publish(
      serverEvent({ type: 'turn.started', turnId: 0, origin: { kind: 'task', taskId: 'task-1' } }),
    );
    subBus.publish(serverEvent({ type: 'turn.step.started', turnId: 0, step: 1 }));
    subBus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 0,
        toolCallId: 'call_q',
        name: 'AskUserQuestion',
        args: {},
      }),
    );

    const questions = session!.accessor.get(ISessionQuestionService);
    const pending = questions.request(
      {
        id: 'call_q',
        turnId: 0,
        toolCallId: 'call_q',
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      { agentId: 'sub-1' },
    );

    const subBody = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(subBody.body.data.pending_interactions).toEqual(['call_q']);
    expect(subBody.body.data.interactions).toContainEqual(
      expect.objectContaining({
        interactionId: 'call_q',
        interactionKind: 'question',
        toolCallId: 'call_q',
        state: 'pending',
      }),
    );

    const mainBody = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(mainBody.body.data.pending_interactions).toEqual([]);

    questions.dismiss('call_q');
    await pending;
  });

  it('rejects path-hostile agent ids with 40001', async () => {
    const id = await createSession();
    const { body } = await getJson<null>(
      `/api/v1/sessions/${id}/transcript?agent_id=${encodeURIComponent('../main')}`,
    );
    expect(body.code).toBe(40001);
  });

  it('rejects before_turn + after_turn together with 40001', async () => {
    const id = await createSession();
    const { body } = await getJson<null>(
      `/api/v1/sessions/${id}/transcript?agent_id=main&before_turn=t2&after_turn=t1`,
    );
    expect(body.code).toBe(40001);
  });

  it('carries the op-batch watermark on the live transcript response', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    const bound = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(bound.body.data.seq).toBeTypeOf('number');
    const base = bound.body.data.seq!;

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const after = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(after.body.data.seq).toBeGreaterThan(base);
  });

  it('serves catch-up batches with seq > since_seq on the ops route', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    const bound = await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const base = bound.body.data.seq!;

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const catchup = await getJson<OpsCatchupContract>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=main&since_seq=${base}`,
    );
    expect(catchup.body.code).toBe(0);
    expect(catchup.body.data.complete).toBe(true);
    expect(catchup.body.data.latest_seq).toBeGreaterThan(base);
    const seqs = catchup.body.data.batches.map((batch) => batch.seq);
    expect(seqs.every((seq) => seq > base)).toBe(true);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    expect(
      catchup.body.data.batches.some((batch) => batch.ops.some((op) => op.op === 'turn.upsert')),
    ).toBe(true);

    const current = await getJson<OpsCatchupContract>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=main&since_seq=${catchup.body.data.latest_seq}`,
    );
    expect(current.body.data).toMatchObject({ batches: [], complete: true });

    const stale = await getJson<OpsCatchupContract>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=main&since_seq=99999`,
    );
    expect(stale.body.data.complete).toBe(false);
  });

  it('answers complete:false for a cold session and 40401 for an unknown one on the ops route', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    await server!.close();
    server = undefined;
    await boot();

    const cold = await getJson<OpsCatchupContract>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=main&since_seq=0`,
    );
    expect(cold.body.code).toBe(0);
    expect(cold.body.data).toMatchObject({ batches: [], complete: false });

    const missing = await getJson<null>(
      `/api/v1/sessions/nope/transcript/ops?agent_id=main&since_seq=0`,
    );
    expect(missing.body.code).toBe(40401);
  });

  it('rejects invalid since_seq / agent_id on the ops route with 40001', async () => {
    const id = await createSession();
    const negative = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=main&since_seq=-1`,
    );
    expect(negative.body.code).toBe(40001);
    const hostile = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/ops?agent_id=${encodeURIComponent('../main')}&since_seq=0`,
    );
    expect(hostile.body.code).toBe(40001);
  });

  it('serves every prompted turn for one agent on the user-messages route (live)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'first' }),
    );
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'task', taskId: 'task-1' } }),
    );
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 2, reason: 'completed' }));
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' }, prompt: 'second' }),
    );
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 3, reason: 'completed' }));

    const { body } = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages?agent_id=main`,
    );
    expect(body.code).toBe(0);
    expect(body.data.agents).toHaveLength(1);
    const main = body.data.agents[0]!;
    expect(main.agent_id).toBe('main');
    expect(main.messages.map((m) => [m.turn_id, m.prompt])).toEqual([
      ['t1', 'first'],
      ['t3', 'second'],
    ]);
    expect(main.messages[0]).toMatchObject({ ordinal: 1, state: 'completed' });
    expect(main.messages[0]!.origin).toMatchObject({ kind: 'user' });
    expect(main.attachments).toEqual([]);
  });

  it('serves per-agent user messages for every rostered agent when agent_id is omitted (live)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append({ role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage);
    await sub.accessor.get(IWireService).flush();

    const bound = await getJson<UserMessagesContract>(`/api/v1/sessions/${id}/transcript/user-messages`);
    const boundByAgent = new Map(bound.body.data.agents.map((a) => [a.agent_id, a]));
    expect(boundByAgent.get('main')!.messages).toEqual([]);
    expect(boundByAgent.get('sub-1')!.messages.map((m) => m.prompt)).toEqual(['scan the repo']);

    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'hello main' }),
    );
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const { body } = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages`,
    );
    expect(body.code).toBe(0);
    const byAgent = new Map(body.data.agents.map((a) => [a.agent_id, a]));
    expect(byAgent.get('main')!.messages.map((m) => m.prompt)).toEqual(['hello main']);
    expect(byAgent.get('sub-1')!.messages.map((m) => m.prompt)).toEqual(['scan the repo']);
  });

  it('rebuilds per-agent user messages for a cold session, folding hidden origins', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'injected reminder' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'reminder' },
      } as ContextMessage,
      {
        role: 'user',
        content: [{ type: 'text', text: 'subagent run prompt' }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'subagent' },
      } as ContextMessage,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'second question' },
          { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
        ],
        toolCalls: [],
      } as ContextMessage,
    ]);
    const session = getLiveSessionById(server!.core.accessor, id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append({ role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage);
    await sub.accessor.get(IWireService).flush();

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages`,
    );
    expect(body.code).toBe(0);
    const byAgent = new Map(body.data.agents.map((a) => [a.agent_id, a]));

    const main = byAgent.get('main')!;
    expect(main.messages.map((m) => [m.turn_id, m.prompt])).toEqual([
      ['t0', 'hi'],
      ['t2', 'second question'],
    ]);
    expect(main.messages[1]!.attachment_ids).toEqual(['att_1']);
    expect(main.attachments).toEqual([
      expect.objectContaining({
        attachmentId: 'att_1',
        mediaType: 'image/*',
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }),
    ]);

    expect(byAgent.get('sub-1')!.messages.map((m) => m.prompt)).toEqual(['scan the repo']);

    const single = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages?agent_id=main`,
    );
    expect(single.body.data.agents.map((a) => a.agent_id)).toEqual(['main']);
  });

  it('lists an attachment-only prompt as an empty-string user message (live)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'user' },
        promptAttachments: [{ kind: 'image', fileId: 'f_upload' }],
      }),
    );
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const { body } = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const main = body.data.agents[0]!;
    expect(main.messages.map((m) => [m.turn_id, m.prompt])).toEqual([['t1', '']]);
    expect(main.messages[0]!.attachment_ids).toEqual(['t1.att1']);
    expect(main.attachments).toEqual([
      expect.objectContaining({
        attachmentId: 't1.att1',
        mediaType: 'image/*',
        source: { kind: 'session_media', fileId: 'f_upload' },
      }),
    ]);
  });

  it('lists an attachment-only prompt as an empty-string user message (cold)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'kimi-file://f_upload?path=%2Ftmp%2Fcache%2Ff_upload.png' } },
        ],
        toolCalls: [],
      } as ContextMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
    ]);

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<UserMessagesContract>(
      `/api/v1/sessions/${id}/transcript/user-messages?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const main = body.data.agents[0]!;
    expect(main.messages.map((m) => [m.turn_id, m.prompt])).toEqual([['t0', '']]);
    expect(main.messages[0]!.attachment_ids).toEqual(['att_1']);
    expect(main.attachments).toEqual([
      expect.objectContaining({
        attachmentId: 'att_1',
        mediaType: 'image/*',
        source: { kind: 'session_media', fileId: 'f_upload' },
      }),
    ]);
  });

  it('answers 40401 for an unknown session and 40001 for a hostile agent id on the user-messages route', async () => {
    const missing = await getJson<null>('/api/v1/sessions/nope/transcript/user-messages');
    expect(missing.body.code).toBe(40401);

    const id = await createSession();
    const hostile = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/user-messages?agent_id=${encodeURIComponent('../main')}`,
    );
    expect(hostile.body.code).toBe(40001);
  });

  it('serves plan info for an ExitPlanMode call from its approval interaction (live)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'build it' }),
    );
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_plan',
        name: 'ExitPlanMode',
        args: {},
      }),
    );

    const planDisplay = {
      kind: 'plan_review',
      plan: '# The Plan\n\nDo the thing.',
      path: '/tmp/plans/foo.md',
      options: [{ label: 'Approach A', description: 'fast' }],
    };
    const session = getLiveSessionById(server!.core.accessor, id);
    const interactions = session!.accessor.get(ISessionInteractionService);
    interactions.enqueue({
      id: 'apr-plan',
      kind: 'approval',
      payload: {
        toolCallId: 'call_plan',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: planDisplay,
      },
      origin: { agentId: 'main', turnId: 1 },
    });
    interactions.respond('apr-plan', { decision: 'approved', selectedLabel: 'Approach A' });

    const { body } = await getJson<PlanContract>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_plan`,
    );
    expect(body.code).toBe(0);
    expect(body.data.agent_id).toBe('main');
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      tool_call_id: 'call_plan',
      turn_id: 't1',
      source: 'interaction',
      plan: '# The Plan\n\nDo the thing.',
      path: '/tmp/plans/foo.md',
      options: [{ label: 'Approach A', description: 'fast' }],
      review: { state: 'approved', selected_option: 'Approach A' },
    });
  });

  it('serves plan info from the live tool frame display when no interaction exists (auto mode)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_plan',
        name: 'ExitPlanMode',
        args: {},
        display: { kind: 'plan_review', plan: '# Auto Plan', path: '/tmp/plans/auto.md' },
      }),
    );
    bus.publish(
      serverEvent({
        type: 'tool.result',
        turnId: 1,
        toolCallId: 'call_plan',
        output:
          'Exited plan mode. Plan mode deactivated. All tools are now available.\nPlan saved to: /tmp/plans/auto.md\n\n## Plan (auto-approved, not user-reviewed):\n# Auto Plan',
      }),
    );

    const { body } = await getJson<PlanContract>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_plan`,
    );
    expect(body.code).toBe(0);
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      source: 'display',
      plan: '# Auto Plan',
      path: '/tmp/plans/auto.md',
    });
    expect(body.data.plans[0]!.review).toBeUndefined();
  });

  it('rebuilds plan info from the tool result output for a cold session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const output =
      'Exited plan mode. Plan mode deactivated. All tools are now available.\nPlan saved to: /tmp/plans/foo.md\n\n## Approved Plan:\n# The Plan\n\nDo the thing.';
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'build it' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_plan', name: 'ExitPlanMode', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: output }],
        toolCalls: [],
        toolCallId: 'call_plan',
      },
    ]);

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<PlanContract>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_plan`,
    );
    expect(body.code).toBe(0);
    expect(body.data.agent_id).toBe('main');
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      tool_call_id: 'call_plan',
      source: 'output',
      plan: '# The Plan\n\nDo the thing.',
      path: '/tmp/plans/foo.md',
    });
    expect(body.data.plans[0]!.review).toBeUndefined();
  });

  it('rebuilds plan info from the persisted interaction for a cold session (revise)', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'build it' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_plan', name: 'ExitPlanMode', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'User requested revisions. Plan mode remains active.' }],
        toolCalls: [],
        toolCallId: 'call_plan',
      },
    ]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const interactions = session!.accessor.get(ISessionInteractionService);
    interactions.enqueue({
      id: 'apr-plan',
      kind: 'approval',
      payload: {
        toolCallId: 'call_plan',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: { kind: 'plan_review', plan: '# Draft Plan', path: '/tmp/plans/foo.md' },
      },
      origin: { agentId: 'main', turnId: 0 },
    });
    interactions.respond('apr-plan', {
      decision: 'rejected',
      selectedLabel: 'Revise',
      feedback: 'split it up',
    });
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    await agent!.accessor.get(IWireService).flush();

    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<PlanContract>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_plan`,
    );
    expect(body.code).toBe(0);
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      source: 'interaction',
      plan: '# Draft Plan',
      path: '/tmp/plans/foo.md',
      review: { state: 'rejected', selected_option: 'Revise', feedback: 'split it up' },
    });
  });

  it('answers 40401 / 40416 / 40001 on the plan route', async () => {
    const missing = await getJson<null>(
      '/api/v1/sessions/nope/transcript/plan?agent_id=main&tool_call_id=call_plan',
    );
    expect(missing.body.code).toBe(40401);

    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(
      serverEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_bash', name: 'Bash', args: {} }),
    );
    bus.publish(serverEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_bash', output: 'ok' }));

    const unknown = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_nope`,
    );
    expect(unknown.body.code).toBe(40416);

    const notPlan = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main&tool_call_id=call_bash`,
    );
    expect(notPlan.body.code).toBe(40416);

    const hostile = await getJson<null>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=${encodeURIComponent('../main')}&tool_call_id=call_plan`,
    );
    expect(hostile.body.code).toBe(40001);
  });

  it('lists every ExitPlanMode plan of the agent when tool_call_id is omitted', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptContract>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 1 }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_draft',
        name: 'ExitPlanMode',
        args: {},
        display: { kind: 'plan_review', plan: '# Draft' },
      }),
    );
    bus.publish(
      serverEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_bash', name: 'Bash', args: {} }),
    );
    bus.publish(serverEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_bash', output: 'ok' }));
    bus.publish(serverEvent({ type: 'turn.step.completed', turnId: 1, step: 1 }));
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 1, step: 2 }));
    bus.publish(
      serverEvent({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_final',
        name: 'ExitPlanMode',
        args: {},
        display: { kind: 'plan_review', plan: '# Final', path: '/tmp/plans/foo.md' },
      }),
    );

    const session = getLiveSessionById(server!.core.accessor, id);
    const interactions = session!.accessor.get(ISessionInteractionService);
    interactions.enqueue({
      id: 'apr-final',
      kind: 'approval',
      payload: {
        toolCallId: 'call_final',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: { kind: 'plan_review', plan: '# Final', path: '/tmp/plans/foo.md' },
      },
      origin: { agentId: 'main', turnId: 1 },
    });
    interactions.respond('apr-final', { decision: 'approved' });

    const { body } = await getJson<PlanContract>(
      `/api/v1/sessions/${id}/transcript/plan?agent_id=main`,
    );
    expect(body.code).toBe(0);
    expect(body.data.agent_id).toBe('main');
    expect(body.data.plans.map((p) => [p.tool_call_id, p.plan])).toEqual([
      ['call_draft', '# Draft'],
      ['call_final', '# Final'],
    ]);
    expect(body.data.plans[0]!.review).toBeUndefined();
    expect(body.data.plans[1]!.review).toMatchObject({ state: 'approved' });
  });
});
