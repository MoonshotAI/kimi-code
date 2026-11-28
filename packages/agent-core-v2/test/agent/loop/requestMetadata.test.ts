import { CRASHED, STEERED } from '@moonshot-ai/core/loop/index';
import type { LlmResolveControl } from '@moonshot-ai/core/llm/policy/resolver';
import type { LlmRequest } from '@moonshot-ai/core/llm/request';
import { describe, expect, it } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IEventBus } from '#/app/event/eventBus';
import {
  event2FromRecord,
  type Event2,
  type Event2Class,
  type SerializedEvent2,
} from '#/app/event/event2';
import { CoreLoopEvent } from '#/agent/loop/coreLoopEvent';
import { RequestMetadataTracker, createRequestMetadataResolver } from '#/agent/loop/requestMetadata';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { AgentLLMRequestSource } from '#/agent/usage/usage';
import type {
  DurableAgentRuntimeParticipant,
  IEventDispatcher,
  RestorePhase,
} from '#/state/eventDispatcher';
import type { FoldContext } from '#/state/state';

const REPLAY_CLASSES: readonly Event2Class[] = [TurnPrompt, TurnEnded];
const TURN_SOURCE: AgentLLMRequestSource = { type: 'turn', turnId: 0, step: 1 };
const COMPACT_SOURCE: AgentLLMRequestSource = { type: 'operation', requestKind: 'full_compaction' };

class FakeBus {
  private readonly handlers = new Set<(event: Event2) => void>();
  readonly bus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event: Event2) => {
      for (const handler of [...this.handlers]) handler(event);
    },
    subscribe: (cls: Event2Class, handler: (event: Event2) => void): IDisposable => {
      const wrapped = (event: Event2): void => {
        if (event.type === cls.type) handler(event);
      };
      this.handlers.add(wrapped);
      return { dispose: () => this.handlers.delete(wrapped) };
    },
  } as unknown as IEventBus;

  emit(event: CoreLoopEvent['event']): void {
    this.bus.publish(new CoreLoopEvent({ agentId: 'main', event }));
  }

  listenerCount(): number {
    return this.handlers.size;
  }
}

function turnPrompt(turnId: number): TurnPrompt {
  return new TurnPrompt({
    agentId: 'main',
    input: [{ type: 'text', text: 'hi' }],
    origin: { kind: 'user' },
    promptId: `p-${turnId}`,
    turnId,
    trigger: 'normal',
  });
}

class DispatcherStub implements IEventDispatcher {
  declare readonly _serviceBrand: undefined;
  readonly hooks = {} as IEventDispatcher['hooks'];
  restorePhase: RestorePhase = 'new';
  private participant: DurableAgentRuntimeParticipant | undefined;
  readonly persisted: SerializedEvent2[] = [];

  attach(participant: DurableAgentRuntimeParticipant): IDisposable {
    this.participant = participant;
    return { dispose: () => {} };
  }

  async attachLate(participant: DurableAgentRuntimeParticipant): Promise<IDisposable> {
    this.participant = participant;
    this.replayRecords(this.persisted);
    return { dispose: () => {} };
  }

  async dispatch(event: Event2): Promise<void> {
    this.apply(event, false);
    if (REPLAY_CLASSES.includes(event.constructor as Event2Class)) {
      this.persisted.push(event.serialize());
    }
  }

  async restore(): Promise<void> {
    this.replayRecords(this.persisted);
    this.restorePhase = 'ready';
  }

  async flush(): Promise<void> {}

  replayRecords(records: readonly SerializedEvent2[]): void {
    if (this.participant === undefined) return;
    for (const record of records) {
      const cls = REPLAY_CLASSES.find((entry) => entry.type === record.type);
      if (cls === undefined) continue;
      const event = event2FromRecord(cls, record);
      if (event !== undefined) this.apply(event, true);
    }
  }

  private apply(event: Event2, silent: boolean): void {
    const participant = this.participant;
    if (participant === undefined) return;
    if (!participant.events.includes(event.constructor as Event2Class)) return;
    const ctx: FoldContext = {
      silent,
      checkpoint: () => {},
      clearCheckpoints: () => {},
      undoToCheckpoint: () => {},
      emit: () => {},
    };
    const next = participant.transition(participant.getState(), event, ctx);
    if (next !== undefined && next !== participant.getState()) participant.commit(next);
  }
}

function createTracker(dispatcher: IEventDispatcher, bus: IEventBus): RequestMetadataTracker {
  return new RequestMetadataTracker(
    makeAgentScopeContext({ agentId: 'main', agentScope: 'session-a/main' }),
    dispatcher,
    bus,
  );
}

describe('RequestMetadataTracker stepReason', () => {
  it('flips to tool_results only on completed core steps, ignoring retries, crash settling, steer, and aborts', async () => {
    const dispatcher = new DispatcherStub();
    const events = new FakeBus();
    const tracker = createTracker(dispatcher, events.bus);
    await dispatcher.dispatch(turnPrompt(0));
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue', cause: { by: 'test-handler', reason: 'retry' } } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue', cause: CRASHED } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'done', cause: STEERED } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'failed', error: new Error('400') } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'aborted' } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 1, step: 1, outcome: { type: 'continue' } });
    expect(tracker.resolve(TURN_SOURCE).stepReason).toBe('turn_start');

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue' } });
    expect(tracker.resolve({ type: 'turn', turnId: 0, step: 2 }).stepReason).toBe('tool_results');

    events.emit({ type: 'step.ended', turnId: 0, step: 2, outcome: { type: 'continue', cause: { by: 'test-handler', reason: 'retry' } } });
    expect(tracker.resolve({ type: 'turn', turnId: 0, step: 2 }).stepReason).toBe('tool_results');

    expect(tracker.resolve(COMPACT_SOURCE).stepReason).toBe('compact');

    await dispatcher.dispatch(new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }));
    expect(tracker.resolve({ type: 'turn', turnId: 0, step: 3 }).stepReason).toBeUndefined();

    await dispatcher.dispatch(turnPrompt(1));
    expect(tracker.resolve({ type: 'turn', turnId: 1, step: 1 }).stepReason).toBe('turn_start');

    tracker.dispose();
    expect(events.listenerCount()).toBe(0);
  });

  it('stamps X-Msh-Client-Metadata with tool_results after the first step ends', async () => {
    const dispatcher = new DispatcherStub();
    const events = new FakeBus();
    const tracker = createTracker(dispatcher, events.bus);
    const resolver = createRequestMetadataResolver(tracker, () => true);
    const request = {
      content: { messages: [] },
      attributes: { kind: 'loop', turnId: 0, step: 1 },
      endpoint: { url: 'https://127.0.0.1:9/v1', headers: { 'X-Existing': '1' } },
    } as unknown as LlmRequest;
    const ctl: LlmResolveControl = {
      signal: new AbortController().signal,
      report: () => {},
      appliedRecoveries: [],
    };

    await dispatcher.dispatch(turnPrompt(0));
    const first = await resolver.resolve(request, ctl);
    expect(first.endpoint?.headers?.['X-Existing']).toBe('1');
    expect(JSON.parse(first.endpoint?.headers?.['X-Msh-Client-Metadata'] ?? '{}')).toMatchObject({
      step_reason: 'turn_start',
    });

    events.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue' } });
    const second = await resolver.resolve({
      ...request,
      attributes: { kind: 'loop', turnId: 0, step: 2 },
    }, ctl);
    expect(JSON.parse(second.endpoint?.headers?.['X-Msh-Client-Metadata'] ?? '{}')).toMatchObject({
      step_reason: 'tool_results',
    });
  });

  it('resets stepReason to turn_start on wire replay of an unfinished turn and tracks subsequent live steps', async () => {
    const live = new DispatcherStub();
    const liveEvents = new FakeBus();
    createTracker(live, liveEvents.bus);
    await live.dispatch(turnPrompt(0));
    liveEvents.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue' } });

    const restored = new DispatcherStub();
    restored.persisted.push(...live.persisted);
    await restored.restore();
    const restoredEvents = new FakeBus();
    const restoredTracker = createTracker(restored, restoredEvents.bus);
    await restoredTracker.ready;
    expect(restoredTracker.resolve({ type: 'turn', turnId: 0, step: 2 }).stepReason).toBe('turn_start');
    expect(restoredTracker.resolve(COMPACT_SOURCE).stepReason).toBe('compact');

    restoredEvents.emit({ type: 'step.ended', turnId: 0, step: 1, outcome: { type: 'continue', cause: CRASHED } });
    expect(restoredTracker.resolve({ type: 'turn', turnId: 0, step: 2 }).stepReason).toBe('turn_start');

    restoredEvents.emit({ type: 'step.ended', turnId: 0, step: 2, outcome: { type: 'continue' } });
    expect(restoredTracker.resolve({ type: 'turn', turnId: 0, step: 3 }).stepReason).toBe('tool_results');

    const late = new DispatcherStub();
    late.restorePhase = 'ready';
    late.persisted.push(...live.persisted);
    const lateTracker = createTracker(late, new FakeBus().bus);
    await lateTracker.ready;
    expect(lateTracker.resolve({ type: 'turn', turnId: 0, step: 2 }).stepReason).toBe('turn_start');
  });
});
