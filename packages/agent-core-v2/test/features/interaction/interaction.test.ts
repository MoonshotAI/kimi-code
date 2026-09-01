import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentInteractionService } from '#/features/interaction/interactionService';
import {
  enqueueSessionInteraction,
  isSessionInteractionRecentlyResolved,
  listSessionPendingInteractions,
  onSessionInteractionDidResolve,
  respondSessionInteraction,
} from '#/features/interaction/sessionInteractions';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { WireRecord } from '#/wire/record';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

describe('AgentInteractionService', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('request blocks until respond resolves it', async () => {
    const svc = ctx.get(IAgentInteractionService);
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = ctx.get(IAgentInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = ctx.get(IAgentInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = ctx.get(IAgentInteractionService);
    let count = 0;
    const subscription = svc.onDidChangePending(() => count++);
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
    subscription.dispose();
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = ctx.get(IAgentInteractionService);
    const snapshots: (readonly string[])[] = [];
    const subscription = svc.onDidChangePending((e) => snapshots.push(e.pending));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
    subscription.dispose();
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ctx.get(IAgentInteractionService);
    expect(svc.respond('nope', 'x')).toBe(false);
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = ctx.get(IAgentInteractionService);
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = ctx.get(IAgentInteractionService);
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^main:interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = ctx.get(IAgentInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    const subscription = svc.onDidResolve((r) => seen.push(r));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
    subscription.dispose();
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = ctx.get(IAgentInteractionService);
    let count = 0;
    const subscription = svc.onDidResolve(() => count++);
    svc.respond('nope', 'x');
    expect(count).toBe(0);
    subscription.dispose();
  });

  it('cancelPendingForTurn clears pending interactions whose turn has ended', () => {
    const svc = ctx.get(IAgentInteractionService);

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('cancelPendingForTurn resolves cancelled interactions through onDidResolve', () => {
    const svc = ctx.get(IAgentInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    const subscription = svc.onDidResolve((r) => seen.push(r));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.listPending()).toHaveLength(0);
    subscription.dispose();
  });

  it('cancelPendingForTurn is a no-op when no interaction matches', () => {
    const svc = ctx.get(IAgentInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 1 } });
    expect(() => svc.cancelPendingForTurn(99)).not.toThrow();
    expect(svc.listPending()).toHaveLength(1);
  });

  it('cancels pending interactions when their turn ends on the event bus', () => {
    const svc = ctx.get(IAgentInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    const subscription = svc.onDidResolve((r) => seen.push(r));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 3 } });
    ctx.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 3, reason: 'completed' }));

    expect(svc.listPending()).toHaveLength(0);
    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
    subscription.dispose();
  });

  it('journals interaction.request and interaction.resolved as wire records', async () => {
    const svc = ctx.get(IAgentInteractionService);
    const pending = svc.request({
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
    });
    svc.respond('i1', { decision: 'approved' });
    await pending;

    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type.startsWith('interaction.'))).toEqual([
      {
        type: 'interaction.request',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'main',
        request: { toolCallId: 'call-1', toolName: 'Bash' },
        time: expect.any(Number),
      },
      {
        type: 'interaction.resolved',
        agentId: 'main',
        id: 'i1',
        response: { decision: 'approved' },
        time: expect.any(Number),
      },
    ]);
  });

  it('journals turn cancellation as interaction.resolved', async () => {
    const svc = ctx.get(IAgentInteractionService);
    svc.enqueue({ id: 'i1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    const records = await ctx.persistedWireRecords();
    const resolved = records.filter((record) => record.type === 'interaction.resolved');
    expect(resolved).toEqual([
      {
        type: 'interaction.resolved',
        agentId: 'main',
        id: 'i1',
        response: { cancelled: true, reason: 'turn_ended' },
        time: expect.any(Number),
      },
    ]);
  });

  it('resolves pending requests silently when the agent closes', async () => {
    const local = createTestAgent();
    await local.restorePersisted();
    const svc = local.get(IAgentInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    let changes = 0;
    const subResolve = svc.onDidResolve((resolution) => seen.push(resolution));
    const subChange = svc.onDidChangePending(() => changes++);
    const pending = svc.request({ kind: 'question', payload: {} });
    void subResolve;
    void subChange;

    await local.dispose();

    await expect(pending).resolves.toEqual({ cancelled: true, reason: 'agent_closed' });
    expect(seen).toEqual([]);
    expect(changes).toBe(1);
    expect(svc.listPending()).toHaveLength(0);
    expect(svc.respond('main:interaction-0', {})).toBe(false);
  });

  it('isolates interactions between agents', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const mainSvc = ctx.get(IAgentInteractionService);
    const subSvc = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentInteractionService);

    mainSvc.enqueue({ id: 'm1', kind: 'approval', payload: {} });
    subSvc.enqueue({ id: 's1', kind: 'question', payload: {} });

    expect(mainSvc.listPending().map((i) => i.id)).toEqual(['m1']);
    expect(subSvc.listPending().map((i) => i.id)).toEqual(['s1']);
    await lifecycle.remove(sub);
  });

  it('replays persisted records after restart without resurrecting pending interactions', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = createTestAgent({ persistence, autoConfigure: false });
    await first.restorePersisted();
    const firstSvc = first.get(IAgentInteractionService);
    firstSvc.enqueue({ id: 'i1', kind: 'approval', payload: { toolCallId: 'call-1' } });
    firstSvc.respond('i1', { decision: 'approved' });
    firstSvc.enqueue({ id: 'i2', kind: 'question', payload: {} });
    await first.dispose();

    const restarted = createTestAgent({ persistence, autoConfigure: false });
    try {
      await restarted.restorePersisted();
      const svc = restarted.get(IAgentInteractionService);
      expect(svc.listPending()).toEqual([]);
      expect(svc.respond('i1', {})).toBe(false);

      svc.enqueue({ id: 'i3', kind: 'approval', payload: {} });
      expect(svc.listPending().map((i) => i.id)).toEqual(['i3']);
    } finally {
      await restarted.dispose();
    }
  });

  it('skips malformed persisted records during replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const seeded = createTestAgent({ persistence, autoConfigure: false });
    try {
      persistence.records.push(
        { type: 'interaction.request', id: 'bad', kind: 'bogus', request: {} } as unknown as WireRecord,
        { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: '?' } } as unknown as WireRecord,
        { type: 'interaction.resolved', id: 'i1', response: { answer: 'a' } } as unknown as WireRecord,
      );
      await seeded.restorePersisted();

      const svc = seeded.get(IAgentInteractionService);
      expect(svc.listPending()).toEqual([]);
      svc.enqueue({ id: 'i2', kind: 'approval', payload: {} });
      expect(svc.listPending().map((i) => i.id)).toEqual(['i2']);
    } finally {
      await seeded.dispose();
    }
  });
});

describe('session interaction helpers', () => {
  let ctx: TestAgentContext;
  let manager: IAgentLifecycleService;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
    manager = ctx.get(IAgentLifecycleService);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('routes requests to the origin agent service', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });
    const mainSvc = ctx.get(IAgentInteractionService);
    const subSvc = manager.handleOf(sub.agentId)!.accessor.get(IAgentInteractionService);

    enqueueSessionInteraction(manager, {
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
      origin: { agentId: 'agent-1', turnId: 2 },
    });

    expect(subSvc.listPending()).toHaveLength(1);
    expect(mainSvc.listPending()).toHaveLength(0);

    const records = await ctx.persistedWireRecords();
    const request = records.find((record) => record.type === 'interaction.request');
    expect(request).toMatchObject({
      type: 'interaction.request',
      id: 'i1',
      kind: 'approval',
      toolCallId: 'call-1',
      agentId: 'agent-1',
      request: { toolCallId: 'call-1', toolName: 'Bash' },
    });
    await manager.remove(sub);
  });

  it('routes to the main agent when the origin has no agentId', () => {
    const mainSvc = ctx.get(IAgentInteractionService);

    enqueueSessionInteraction(manager, { id: 'i1', kind: 'question', payload: { question: '?' } });

    expect(mainSvc.listPending()).toHaveLength(1);
  });

  it('rejects a request routed to an unknown agent', () => {
    expect(() =>
      enqueueSessionInteraction(manager, {
        id: 'i1',
        kind: 'question',
        payload: {},
        origin: { agentId: 'ghost' },
      }),
    ).toThrow('Agent "ghost" does not exist');
  });

  it('generated ids remain unique across agents', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });

    const mainInteraction = enqueueSessionInteraction(manager, { kind: 'approval', payload: {} });
    const subInteraction = enqueueSessionInteraction(manager, {
      kind: 'question',
      payload: {},
      origin: { agentId: 'agent-1' },
    });

    expect(mainInteraction.id).not.toBe(subInteraction.id);
    expect(mainInteraction.id).toMatch(/^main:/);
    expect(subInteraction.id).toMatch(/^agent-1:/);
    await manager.remove(sub);
  });

  it('listPending aggregates across agents', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });

    enqueueSessionInteraction(manager, { id: 'i1', kind: 'approval', payload: {} });
    enqueueSessionInteraction(manager, {
      id: 'i2',
      kind: 'question',
      payload: {},
      origin: { agentId: 'agent-1' },
    });

    expect(listSessionPendingInteractions(manager).map((i) => i.id).sort()).toEqual(['i1', 'i2']);
    expect(listSessionPendingInteractions(manager, 'approval').map((i) => i.id)).toEqual(['i1']);
    await manager.remove(sub);
  });

  it('respond finds the owning agent', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });
    const subSvc = manager.handleOf(sub.agentId)!.accessor.get(IAgentInteractionService);

    const pending = subSvc.request<unknown, string>({ kind: 'question', payload: {} });
    respondSessionInteraction(manager, subSvc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(listSessionPendingInteractions(manager)).toHaveLength(0);
    await manager.remove(sub);
  });

  it('respond to an unknown id is a no-op', () => {
    expect(() => respondSessionInteraction(manager, 'nope', 'x')).not.toThrow();
  });

  it('isRecentlyResolved checks every agent', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });
    const subSvc = manager.handleOf(sub.agentId)!.accessor.get(IAgentInteractionService);

    subSvc.enqueue({ id: 'i1', kind: 'approval', payload: {} });
    subSvc.respond('i1', {});

    expect(isSessionInteractionRecentlyResolved(manager, 'i1')).toBe(true);
    expect(isSessionInteractionRecentlyResolved(manager, 'ghost')).toBe(false);
    await manager.remove(sub);
  });

  it('onDidResolve fans out across agents', async () => {
    const sub = await manager.create({ agentId: 'agent-1' });
    const subSvc = manager.handleOf(sub.agentId)!.accessor.get(IAgentInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    const subscription = onSessionInteractionDidResolve(manager, (r) => seen.push(r));

    subSvc.enqueue({ id: 's1', kind: 'question', payload: {} });
    subSvc.respond('s1', { answer: 1 });
    ctx.get(IAgentInteractionService).enqueue({ id: 'm1', kind: 'approval', payload: {} });
    respondSessionInteraction(manager, 'm1', { decision: 'approved' });

    expect(seen).toEqual([
      { id: 's1', response: { answer: 1 } },
      { id: 'm1', response: { decision: 'approved' } },
    ]);
    subscription.dispose();
    await manager.remove(sub);
  });
});
