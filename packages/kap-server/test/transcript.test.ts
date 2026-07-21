/**
 * `GET /api/v1/sessions/{sid}/transcript` — live store reads, interaction
 * frames, turn pagination, cold wire rebuild, and query validation.
 *
 * Boots a real server (`startServer`) on a temp home so the live path runs
 * through the real core binding (event bus → projector → store); the cold
 * path re-boots the server on the same home so the session drops out of
 * memory and the route falls back to the wire-records rebuild.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IWireService,
  IEventBus,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionQuestionService,
  IModelCatalog,
  type ContextMessage,
  type DomainEvent,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface FrameWire {
  kind: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  interactionKind?: string;
  [key: string]: unknown;
}

interface TurnWire {
  kind: 'turn';
  turnId: string;
  state: string;
  origin?: { kind: string };
  prompt?: string;
  steps: { stepId: string; state: string; frames: FrameWire[] }[];
}

interface TranscriptWire {
  agent_id: string;
  items: (TurnWire | { kind: 'marker' | 'taskref' })[];
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
}

function serverEvent(payload: Record<string, unknown>): DomainEvent {
  return payload as unknown as DomainEvent;
}

describe('server-v2 /api/v1/sessions/{sid}/transcript', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let seeds: ScopeSeed | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-transcript-'));
    // Seed a stub IModelCatalog so the agent scope can instantiate if a
    // transitive service needs it; the transcript route itself does not.
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

  /** Ensure the main agent exists (server-v2 does not create it with the session). */
  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    if (session.accessor.get(IAgentLifecycleService).get('main') === undefined) {
      await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    }
  }

  function mainAgentBus(sessionId: string): IEventBus {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    return agent!.accessor.get(IEventBus);
  }

  async function seedMainAgentMessages(
    sessionId: string,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    agent!.accessor.get(IAgentContextMemoryService).append(...messages);
    await agent!.accessor.get(IWireService).flush();
  }

  it('streams a live turn tree: deltas flush into full-text frames at step end', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    // First read binds the transcript (empty).
    const empty = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
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

    const { body } = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't1',
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
    // Roster descriptor for the main agent is present.
    await vi.waitFor(async () => {
      const again = await getJson<TranscriptWire>(
        `/api/v1/sessions/${id}/transcript?agent_id=main`,
      );
      expect(again.body.data.agents).toContainEqual({ agentId: 'main', type: 'main' });
    });
  });

  it('surfaces approval interactions as global entities with pending ids', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    // Bind first so the interaction listeners are attached.
    await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

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

    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
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

    let { body } = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
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
    ({ body } = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`));
    expect(body.data.pending_interactions).toEqual([]);
    expect(body.data.interactions).toContainEqual(
      expect.objectContaining({ interactionId: 'apr-1', state: 'approved' }),
    );
    const frames = (body.data.items[0] as TurnWire).steps[0]!.frames;
    expect(frames).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_9', approvalId: 'apr-1' }),
    );
  });

  it('paginates live turns with page_size and before_turn', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

    const bus = mainAgentBus(id);
    for (const turnId of [1, 2, 3]) {
      bus.publish(serverEvent({ type: 'turn.started', turnId, origin: { kind: 'user' } }));
      bus.publish(serverEvent({ type: 'turn.ended', turnId, reason: 'completed' }));
    }

    const page = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main&page_size=2`,
    );
    expect(page.body.data.items.map((item) => (item as TurnWire).turnId)).toEqual(['t2', 't3']);
    expect(page.body.data.has_more).toBe(true);

    const older = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main&page_size=2&before_turn=t3`,
    );
    expect(older.body.data.items.map((item) => (item as TurnWire).turnId)).toEqual(['t1', 't2']);
    expect(older.body.data.has_more).toBe(false);

    // Unknown agent id on a live session pages empty instead of 404ing.
    const unknown = await getJson<TranscriptWire>(
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

    // Reboot on the same home — the session drops out of memory.
    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    expect(body.data.has_more).toBe(false);
    expect(body.data.agents).toEqual([{ agentId: 'main', type: 'main' }]);
    expect(body.data.pending_interactions).toEqual([]);

    const turn = body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
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

    // Cold reads of an agent without any records page empty.
    const sub = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
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

    // Reboot on the same home, then RESUME the session: it is live again, so
    // the route answers from the live store — which must first backfill the
    // persisted history (0-based ordinals, matching the engine's numbering).
    await server!.close();
    server = undefined;
    await boot();
    await server!.core.accessor.get(ISessionLifecycleService).resume(id);

    const { body } = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.state).toBe('completed');
    expect(turn!.prompt).toBe('hi');

    // A subsequent live turn continues the ordinal sequence without collision.
    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    const again = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=main`,
    );
    expect(again.body.data.items.map((item) => (item as TurnWire).turnId)).toEqual(['t0', 't1']);
  });

  it('rebuilds a subagent for a cold session from its own wire records', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
        { role: 'assistant', content: [{ type: 'text', text: 'scanning' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    // Reboot on the same home — the session drops out of memory.
    await server!.close();
    server = undefined;
    await boot();

    const { body } = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=sub-1`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.prompt).toBe('scan the repo');
    // An agent without any records still pages empty.
    const none = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);
  });

  it('backfills an unmaterialized subagent for a resumed live session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
        { role: 'assistant', content: [{ type: 'text', text: 'scanning' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    // Reboot + resume: the subagent is not materialized again, but its
    // transcript must come back established from the persisted records, and
    // the roster must list it.
    await server!.close();
    server = undefined;
    await boot();
    await server!.core.accessor.get(ISessionLifecycleService).resume(id);
    expect(
      server!.core.accessor
        .get(ISessionLifecycleService)
        .get(id)!
        .accessor.get(IAgentLifecycleService)
        .get('sub-1'),
    ).toBeUndefined();

    const { body } = await getJson<TranscriptWire>(
      `/api/v1/sessions/${id}/transcript?agent_id=sub-1`,
    );
    expect(body.code).toBe(0);
    const turn = body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turn).toBeDefined();
    expect(turn!.prompt).toBe('scan the repo');
    expect(body.data.agents).toContainEqual(expect.objectContaining({ agentId: 'sub-1' }));
  });

  it('keeps the metadata-seeded subagent descriptor after an on-demand backfill', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    const sub = await session!.accessor
      .get(IAgentLifecycleService)
      .create({ agentId: 'sub-1', labels: { parentAgentId: 'main' } });
    sub.accessor
      .get(IAgentContextMemoryService)
      .append(
        { role: 'user', content: [{ type: 'text', text: 'scan the repo' }], toolCalls: [] } as ContextMessage,
      );
    await sub.accessor.get(IWireService).flush();

    // The roster seeds from session metadata when the transcript binds; the
    // subsequent on-demand backfill for the subagent must not downgrade the
    // descriptor back to `{ agentId, type }`.
    await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const { body } = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(body.code).toBe(0);
    expect(body.data.agents).toContainEqual(
      expect.objectContaining({ agentId: 'sub-1', type: 'sub', parentAgentId: 'main' }),
    );
  });

  it('announces a pre-existing pending approval against the backfilled tool frame', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    // Persist a tool call (assistant message with toolCalls) before anything
    // binds — the persisted frame is the placement/back-link target.
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'call_9', name: 'Bash', arguments: '{"command":"ls"}' }],
      },
    ]);

    // The approval is already pending when the transcript binds.
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    session!.accessor.get(ISessionInteractionService).enqueue({
      id: 'apr-1',
      kind: 'approval',
      payload: { toolCallId: 'call_9', toolName: 'Bash', action: 'run' },
      origin: { agentId: 'main', turnId: 0 },
    });

    // Binding defers the announce until after the backfill, so the entity
    // anchors at the backfilled tool call and resolve can back-link it.
    const { body } = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
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
    const after = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const turnAfter = after.body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(turnAfter!.steps.flatMap((step) => step.frames)).toContainEqual(
      expect.objectContaining({ kind: 'tool', toolCallId: 'call_9', approvalId: 'apr-1' }),
    );
  });

  it('does not roster a ghost agent for an unknown agent id on a live session', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    // Probing a nonexistent agent pages empty (no wire records)…
    const none = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);

    // …but must not conjure a ghost roster entry.
    const main = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(main.body.data.agents.map((a) => a.agentId)).not.toContain('nope');
  });

  it('seeds a subagent pending question only after its own backfill', async () => {
    const id = await createSession();
    await ensureMainAgent(id);
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
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

    // The subagent's question is pending BEFORE the transcript binds.
    const questions = session!.accessor.get(ISessionQuestionService);
    const pending = questions.request(
      {
        turnId: 0,
        toolCallId: 'call_q',
        questions: [{ question: 'Pick?', options: [{ label: 'A' }] }],
      },
      { agentId: 'sub-1' },
    );

    // Binding seeds only main-owned pendings after the main backfill — the
    // subagent's question waits for its own history.
    const mainBody = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(mainBody.body.data.pending_interactions).toEqual([]);

    const subBody = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
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

    // Reboot on the same home — the session drops out of memory (cold path).
    await server!.close();
    server = undefined;
    await boot();

    const none = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=nope`);
    expect(none.body.code).toBe(0);
    expect(none.body.data.items).toEqual([]);
    // No ghost entry for the probe — and the roster still comes from the
    // persisted session metadata.
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

    // Bind the live store; the backfill serves the persisted turn.
    const bound = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(bound.body.data.items).toHaveLength(1);

    // A live-only turn (never persisted) distinguishes the stale store from
    // the cold rebuild: served live it would show up, from disk it cannot.
    const bus = mainAgentBus(id);
    bus.publish(serverEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    await server!.core.accessor.get(ISessionLifecycleService).close(id);

    const { body } = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => (item as TurnWire).turnId)).toEqual(['t0']);
    const turn = body.data.items[0] as TurnWire;
    expect(turn.prompt).toBe('hi');
    expect(turn.steps[0]!.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'hello there' }),
    );
  });

  it('heals the missing stream prefix after a mid-turn attach once the turn ends', async () => {
    const id = await createSession();
    await ensureMainAgent(id);

    // A turn is already streaming, but none of the step content is persisted
    // yet (the engine flushes response content when the request completes).
    const bus = mainAgentBus(id);
    bus.publish(
      serverEvent({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }),
    );
    bus.publish(serverEvent({ type: 'turn.step.started', turnId: 0, step: 1 }));
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 0, delta: 'Hello ' }));
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    // The transcript attaches now: the backfill sees only the user message
    // and the projector missed the early deltas, so the live frame ends up
    // suffix-only.
    await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    bus.publish(serverEvent({ type: 'assistant.delta', turnId: 0, delta: 'world' }));
    const suffix = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
    const suffixTurn = suffix.body.data.items.find(
      (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
    );
    expect(suffixTurn!.steps[0]!.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'world' }),
    );

    // The request completes: the full text lands on disk, then the turn ends.
    await seedMainAgentMessages(id, [
      { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], toolCalls: [] },
    ]);
    bus.publish(serverEvent({ type: 'turn.step.completed', turnId: 0, step: 1 }));
    bus.publish(serverEvent({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

    // The debounced post-turn heal re-reads the persisted turn and merges it
    // back: the prefix is restored and the header recovers origin/prompt.
    await vi.waitFor(
      async () => {
        const { body } = await getJson<TranscriptWire>(
          `/api/v1/sessions/${id}/transcript?agent_id=main`,
        );
        const turn = body.data.items.find(
          (item): item is TurnWire => item.kind === 'turn' && item.turnId === 't0',
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
    const session = server!.core.accessor.get(ISessionLifecycleService).get(id);
    const sub = await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-1' });

    // Bind the transcript (main + any agent appearing later).
    await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);

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

    // The question carries its owning agent on the interaction origin (see
    // ISessionQuestionService.request's agentId option).
    const questions = session!.accessor.get(ISessionQuestionService);
    const pending = questions.request(
      {
        turnId: 0,
        toolCallId: 'call_q',
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      { agentId: 'sub-1' },
    );

    const subBody = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=sub-1`);
    expect(subBody.body.data.pending_interactions).toEqual(['call_q']);
    expect(subBody.body.data.interactions).toContainEqual(
      expect.objectContaining({
        interactionId: 'call_q',
        interactionKind: 'question',
        toolCallId: 'call_q',
        state: 'pending',
      }),
    );

    const mainBody = await getJson<TranscriptWire>(`/api/v1/sessions/${id}/transcript?agent_id=main`);
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
});
