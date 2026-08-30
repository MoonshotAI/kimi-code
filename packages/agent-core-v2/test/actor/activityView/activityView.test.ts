import { afterEach, describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { IDisposable } from '#/_base/di/lifecycle';
import { stubAgentContext } from '../../agent/agentContext/stubs';
import { IAgentHostService } from '#/agent/host/agentHost';
import { AgentRuntimeSet } from '#/actor/agentRuntimeSet';
import { AgentTask } from '#/actor/task/taskAgentRuntime';
import { TaskStarted } from '#/actor/task/taskOps';
import type { AgentTaskInfo } from '#/actor/task/types';
import {
  AgentActivityView,
  activityViewAgentRuntimeProvider,
  type ActivityViewRuntime,
} from '#/actor/activityView/activityViewAgentRuntime';
import { AgentActivityUpdated } from '#/actor/activityView/activityViewEvents';
import type { AgentActivityState } from '#/actor/activityView/types';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { AgentLoop, type LoopActivity } from '#/actor/loop/loop';
import { getLoopControl } from '#/actor/loop/internal/access';
import { MessageStepRequest } from '#/actor/loop/internal/stepRequest';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import type { ActiveToolCall } from '#/actor/toolExecutor/toolExecutor';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import type { PendingToolApproval } from '#/agent/toolApproval/toolApproval';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  llmGenerateServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';
import { emptyUsage } from '#/kosong/contract/usage';

class FakeBus {
  private readonly byType = new Map<string, Array<(e: Event2) => void>>();
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    for (const h of this.byType.get(event.type) ?? []) h(event);
  }

  subscribe(typeOrClass: unknown, handler?: unknown): IDisposable {
    const type =
      typeof typeOrClass === 'string' ? typeOrClass : (typeOrClass as Event2Class).type;
    const list = this.byType.get(type) ?? [];
    list.push(handler as (e: Event2) => void);
    this.byType.set(type, list);
    return { dispose: () => {} };
  }
}

interface ProjectionWorld {
  loopActivity: LoopActivity;
  readonly loopEmitter: Emitter<LoopActivity>;
  pending: PendingToolApproval[];
  activeCalls: ActiveToolCall[];
  tasks: AgentTaskInfo[];
  compactionSince: number | undefined;
  readonly bus: FakeBus;
  readonly view: ActivityViewRuntime;
  readonly updates: AgentActivityState[];
  close(): Promise<void>;
}

function createProjectionWorld(): ProjectionWorld {
  const bus = new FakeBus();
  const loopEmitter = new Emitter<LoopActivity>();
  const pendingEmitter = new Emitter<void>();
  const callsEmitter = new Emitter<readonly ActiveToolCall[]>();
  const agent = stubAgentContext('main', 1);
  const world = {
    loopActivity: {} as LoopActivity,
    loopEmitter,
    pending: [] as PendingToolApproval[],
    activeCalls: [] as ActiveToolCall[],
    tasks: [] as AgentTaskInfo[],
    compactionSince: undefined as number | undefined,
  };
  const accessor = {
    get: (id: unknown): unknown => {
      if (id === IAgentHostService) return { of: () => ({ eventBus: bus }) };
      if (id === ISessionToolApprovalService) {
        return {
          of: () => ({
            pendingApprovals: () => world.pending,
            onDidChangePending: pendingEmitter.event,
          }),
        };
      }
      if (id === IAgentLifecycleService) {
        return {
          resolve: (_agent: unknown, definition: unknown) => {
            if (definition === AgentLoop) {
              return {
                activity: () => world.loopActivity,
                onDidChangeActivity: loopEmitter.event,
              };
            }
            if (definition === AgentTools) {
              return {
                activeCalls: () => world.activeCalls,
                onDidChangeActiveCalls: callsEmitter.event,
              };
            }
            if (definition === AgentTask) return { list: () => world.tasks };
            if (definition === AgentFullCompaction) {
              return { runningSince: () => world.compactionSince };
            }
            throw new Error(`unexpected runtime resolution: ${String(definition)}`);
          },
        };
      }
      throw new Error(`unexpected service resolution: ${String(id)}`);
    },
  };
  const updates: AgentActivityState[] = [];
  const dispatcher = {
    dispatch: (event: Event2) => {
      if (event instanceof AgentActivityUpdated) updates.push(event);
      bus.publish(event);
      return Promise.resolve();
    },
  };
  const runtimes = new AgentRuntimeSet(agent, accessor as never, () => dispatcher as never);
  runtimes.apply({
    definition: AgentActivityView,
    provider: activityViewAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  return Object.assign(world, {
    loopEmitter,
    bus,
    view: runtimes.resolve(AgentActivityView),
    updates,
    close: () => runtimes.close(),
  });
}

function makeTaskInfo(taskId: string, startedAt = 100): AgentTaskInfo {
  return {
    taskId,
    kind: 'process',
    description: 'sleep 60',
    status: 'running',
    startedAt,
    endedAt: null,
    command: 'sleep 60',
    pid: 4242,
    exitCode: null,
  };
}

function turnEndedRecord(turnId: number, reason: string, durationMs?: number): WireRecord {
  return { type: 'turn.ended', agentId: 'main', turnId, reason, durationMs, time: 1 };
}

function nextTurnMessage(text: string): MessageStepRequest {
  return new MessageStepRequest(
    {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
    { admission: 'newTurn' },
  );
}

async function runScriptedTurn(ctx: TestAgentContext, text: string): Promise<void> {
  const loop = getLoopControl(ctx.agentContext);
  const { turn } = await loop.enqueue(nextTurnMessage(text)).assigned;
  await turn.result;
}

function scriptedResponse(text: string) {
  return {
    id: `response-${text}`,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      toolCalls: [],
    },
    usage: emptyUsage(),
    finishReason: 'completed' as const,
    rawFinishReason: 'stop',
  };
}

describe('AgentActivityView projection', () => {
  const worlds: ProjectionWorld[] = [];

  afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
  });

  function projection(): ProjectionWorld {
    const world = createProjectionWorld();
    worlds.push(world);
    return world;
  }

  it('starts with an empty, not-busy snapshot', () => {
    const world = projection();
    expect(world.view.state()).toEqual({ lifecycle: 'ready', background: [] });
    expect(world.updates).toHaveLength(0);
  });

  it('projects the loop turn activity into the turn slice', () => {
    const world = projection();
    world.loopActivity = {
      turn: { turnId: 1, origin: { kind: 'user' }, since: 50, step: 2, phase: 'toolCalling' },
    };
    world.activeCalls = [
      { toolCallId: 'tc-1', name: 'Bash', turnId: 1, since: 60 },
      { toolCallId: 'tc-stale', name: 'Bash', turnId: 0, since: 10 },
    ];
    world.pending = [{ approvalId: 'approval_1', toolCallId: 'tc-1', since: 70 }];
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn).toEqual({
      turnId: 1,
      origin: { kind: 'user' },
      phase: 'tool_call',
      stream: undefined,
      step: 2,
      ending: false,
      endingReason: undefined,
      retry: undefined,
      pendingApprovals: [{ approvalId: 'approval_1', toolCallId: 'tc-1', since: 70 }],
      activeToolCalls: [{ toolCallId: 'tc-1', name: 'Bash', since: 60 }],
      since: 50,
    });
    expect(world.updates.at(-1)?.turn?.turnId).toBe(1);
  });

  it('maps loop phases and retry state to the wire turn phases', () => {
    const world = projection();
    const base = { turnId: 3, origin: { kind: 'user' as const }, since: 1, step: 1 };
    world.loopActivity = { turn: { ...base, phase: 'working' } };
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn?.phase).toBe('running');

    world.loopActivity = { turn: { ...base, phase: 'streaming', stream: 'thinking' } };
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn).toMatchObject({ phase: 'streaming', stream: 'thinking' });

    const retry = { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 10 };
    world.loopActivity = { turn: { ...base, phase: 'retrying', retry } };
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn).toMatchObject({ phase: 'retrying', retry });
  });

  it('projects interrupting into the ending flags', () => {
    const world = projection();
    world.loopActivity = {
      turn: {
        turnId: 4,
        origin: { kind: 'user' },
        since: 1,
        step: 2,
        phase: 'working',
        interrupting: 'max_steps',
      },
    };
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn).toMatchObject({ ending: true, endingReason: 'max_steps' });
  });

  it('passes the loop lastTurn through when idle', () => {
    const world = projection();
    world.loopActivity = { lastTurn: { turnId: 7, reason: 'failed', durationMs: 1234, at: 99 } };
    world.loopEmitter.fire(world.loopActivity);
    expect(world.view.state().turn).toBeUndefined();
    expect(world.view.state().lastTurn).toEqual({
      turnId: 7,
      reason: 'failed',
      durationMs: 1234,
      at: 99,
    });
  });

  it('composes background from running tasks and compaction sorted by start time', () => {
    const world = projection();
    world.tasks = [makeTaskInfo('bash-1', 100)];
    world.compactionSince = 50;
    world.bus.publish(new TaskStarted({ agentId: 'main', info: makeTaskInfo('bash-1', 100) }));
    expect(world.view.state().background).toEqual([
      { kind: 'compaction', id: 'full-compaction', since: 50 },
      { kind: 'process', id: 'bash-1', since: 100 },
    ]);
  });

  it('skips republishing identical snapshots', () => {
    const world = projection();
    world.loopActivity = { lastTurn: { turnId: 1, reason: 'completed', at: 5 } };
    world.loopEmitter.fire(world.loopActivity);
    world.loopEmitter.fire(world.loopActivity);
    expect(world.updates).toHaveLength(1);
  });

  it('publishes a final disposed snapshot on close', async () => {
    const world = projection();
    world.loopActivity = { lastTurn: { turnId: 1, reason: 'completed', at: 5 } };
    world.loopEmitter.fire(world.loopActivity);
    await world.close();
    const final = world.updates.at(-1);
    expect(final?.lifecycle).toBe('disposed');
    expect(final?.lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });
});

describe('AgentActivityView against the live loop', () => {
  const contexts: TestAgentContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.dispose();
  });

  function harness(
    ...inputs: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    const ctx = createTestAgent(...inputs);
    contexts.push(ctx);
    return ctx;
  }

  function track(ctx: TestAgentContext): { view: ActivityViewRuntime } {
    return { view: ctx.resolve(AgentActivityView) };
  }

  it('projects a live turn and folds it into lastTurn when the turn ends', async () => {
    const midTurn: AgentActivityState[] = [];
    const ctx = harness(
      llmGenerateServices(async () => {
        midTurn.push(ctx.resolve(AgentActivityView).state());
        return scriptedResponse('done');
      }),
    );
    const { view } = track(ctx);

    await runScriptedTurn(ctx, 'hi');

    expect(midTurn.at(0)?.turn).toMatchObject({
      turnId: 0,
      origin: { kind: 'user' },
      phase: 'running',
      step: 1,
    });
    expect(view.state().turn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 0, reason: 'completed' });
  });

  it('clears the previous outcome while the next turn runs', async () => {
    const midTurn: AgentActivityState[] = [];
    const ctx = harness(
      llmGenerateServices(async () => {
        midTurn.push(ctx.resolve(AgentActivityView).state());
        return scriptedResponse('done');
      }),
    );
    const { view } = track(ctx);

    await runScriptedTurn(ctx, 'first');
    expect(view.state().lastTurn).toMatchObject({ turnId: 0, reason: 'completed' });

    await runScriptedTurn(ctx, 'second');
    expect(midTurn.at(1)?.lastTurn).toBeUndefined();
    expect(view.state().lastTurn).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('seeds lastTurn from the wire turnKey when the view is built after restore', async () => {
    const ctx = harness(
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence([
          createWireMetadataRecord(1),
          turnEndedRecord(7, 'failed', 1234),
        ]),
      ),
    );
    await ctx.restorePersisted();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('seeds lastTurn when the wire restore lands after construction (cold resume ordering)', async () => {
    const ctx = harness();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toBeUndefined();
    await ctx.restore([turnEndedRecord(7, 'failed', 1234)]);
    expect(view.state().lastTurn).toMatchObject({ turnId: 7, reason: 'failed', durationMs: 1234 });
  });

  it('does not overwrite a live lastTurn when the restore hook runs', async () => {
    const ctx = harness(llmGenerateServices(async () => scriptedResponse('done')));
    const { view } = track(ctx);
    await runScriptedTurn(ctx, 'hi');
    await ctx.restore([turnEndedRecord(7, 'failed', 1234)]);
    expect(view.state().lastTurn).toMatchObject({ turnId: 0, reason: 'completed' });
  });

  it('leaves lastTurn empty when the wire has no ended turn', () => {
    const ctx = harness();
    const { view } = track(ctx);
    expect(view.state().lastTurn).toBeUndefined();
  });
});
