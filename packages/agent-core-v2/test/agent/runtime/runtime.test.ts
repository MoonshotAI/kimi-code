import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { PermissionApprovalRequestContext } from '#/agent/permissionGate/permissionGateService';
import { type AgentPhase, IAgentRuntimeService } from '#/agent/runtime/runtime';
import { AgentRuntimeService } from '#/agent/runtime/runtimeService';
import { RuntimeModel } from '#/agent/runtime/runtimeOps';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'runtime-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let eventBus: IEventBus;
let svc: IAgentRuntimeService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentRuntimeService, new SyncDescriptor(AgentRuntimeService));
  log = ix.get(IAppendLogStore);
  eventBus = ix.get(IEventBus);
  svc = ix.get(IAgentRuntimeService);
});

afterEach(() => disposables.dispose());

function collect(): AgentPhase[] {
  const phases: AgentPhase[] = [];
  disposables.add(
    eventBus.subscribe('agent.status.updated', (e: DomainEvent<'agent.status.updated'>) => {
      if (e.phase !== undefined) phases.push(e.phase);
    }),
  );
  return phases;
}

async function readRecords(): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, KEY)) {
    out.push(record);
  }
  return out;
}

function startTurn(turnId = 1, step = 1, stepId = 's1'): void {
  eventBus.publish({ type: 'turn.started', turnId, origin: USER_PROMPT_ORIGIN });
  eventBus.publish({ type: 'turn.step.started', turnId, step, stepId });
}

const approval = {
  toolCallId: 'c1',
  toolName: 'Read',
  action: 'read',
  display: {},
  turnId: 1,
  toolInput: { path: '/tmp/x' },
} as unknown as PermissionApprovalRequestContext;

describe('AgentRuntimeService', () => {
  it('starts idle', () => {
    expect(svc.phase()).toEqual({ kind: 'idle' });
  });

  it('turn.started then turn.step.started → running with step cursor', () => {
    const phases = collect();
    startTurn();

    expect(svc.phase()).toMatchObject({ kind: 'running', turnId: 1, step: 1, stepId: 's1' });
    expect(phases.map((p) => p.kind)).toEqual(['running', 'running']);
  });

  it('first assistant.delta enters streaming(assistant); subsequent deltas are debounced', () => {
    const phases = collect();
    startTurn();
    const baseline = phases.length;

    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'he' });
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'llo' });

    expect(svc.phase()).toMatchObject({ kind: 'streaming', stream: 'assistant' });
    expect(phases.length).toBe(baseline + 1);
  });

  it('thinking.delta switches the stream variant', () => {
    startTurn();
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'x' });
    eventBus.publish({ type: 'thinking.delta', turnId: 1, delta: 'hmm' });

    expect(svc.phase()).toMatchObject({ kind: 'streaming', stream: 'thinking' });
  });

  it('tool.call.delta → streaming(tool_call); tool.call.started → tool_call; tool.result → running', () => {
    const phases = collect();
    startTurn();

    eventBus.publish({
      type: 'tool.call.delta',
      turnId: 1,
      toolCallId: 'c1',
      name: 'Read',
      argumentsPart: '{',
    });
    expect(svc.phase()).toMatchObject({
      kind: 'streaming',
      stream: 'tool_call',
      toolCallId: 'c1',
      toolName: 'Read',
    });

    eventBus.publish({ type: 'tool.call.started', turnId: 1, toolCallId: 'c1', name: 'Read', args: {} });
    expect(svc.phase()).toMatchObject({ kind: 'tool_call', toolCallId: 'c1', name: 'Read' });

    eventBus.publish({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'ok', isError: false });
    expect(svc.phase()).toMatchObject({ kind: 'running', turnId: 1, step: 1 });
    expect(phases.map((p) => p.kind)).toEqual([
      'running',
      'running',
      'streaming',
      'tool_call',
      'running',
    ]);
  });

  it('turn.step.retrying → retrying with the backoff fields', () => {
    startTurn();
    eventBus.publish({
      type: 'turn.step.retrying',
      turnId: 1,
      step: 1,
      stepId: 's1',
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorName: 'RateLimitError',
      errorMessage: 'slow down',
      statusCode: 429,
    });

    expect(svc.phase()).toMatchObject({
      kind: 'retrying',
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorName: 'RateLimitError',
      statusCode: 429,
    });
  });

  it('turn.step.interrupted → interrupted(reason)', () => {
    startTurn();
    eventBus.publish({ type: 'turn.step.interrupted', turnId: 1, step: 1, reason: 'aborted' });

    expect(svc.phase()).toMatchObject({ kind: 'interrupted', reason: 'aborted' });
  });

  it('turn.ended → ended(reason)', () => {
    startTurn();
    eventBus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 123 });

    expect(svc.phase()).toMatchObject({ kind: 'ended', turnId: 1, reason: 'completed', durationMs: 123 });
  });

  it('permission approval requests pause into awaiting_approval and resolve back to the prior phase', () => {
    startTurn();
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'hi' });
    expect(svc.phase().kind).toBe('streaming');

    eventBus.publish({ type: 'permission.approval.requested', ...approval });
    expect(svc.phase().kind).toBe('awaiting_approval');

    eventBus.publish({ type: 'permission.approval.resolved', ...approval, decision: 'approved' });
    expect(svc.phase()).toMatchObject({ kind: 'streaming', stream: 'assistant' });
  });

  it('never persists runtime.set_phase (live-only)', async () => {
    startTurn();
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'a' });
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'b' });
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'c' });
    eventBus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 1 });

    expect(await readRecords()).toEqual([]);
  });

  it('fresh replay leaves the phase at idle silently (no persisted phase records)', async () => {
    startTurn();
    eventBus.publish({ type: 'assistant.delta', turnId: 1, delta: 'hi' });
    eventBus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 5 });
    const records = await readRecords();
    expect(records).toEqual([]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'runtime-replay' }]));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    const fresh = ix2.get(IAgentWireService);
    const bus2 = ix2.get(IEventBus);

    const emitted: DomainEvent[] = [];
    disposables.add(bus2.subscribe((e) => emitted.push(e)));

    await fresh.replay(...records);

    expect(fresh.getModel(RuntimeModel).phase).toEqual({ kind: 'idle' });
    expect(emitted.filter((e) => e.type === 'agent.status.updated')).toHaveLength(0);
  });
});
