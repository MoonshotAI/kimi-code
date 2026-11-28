import { describe, expect, it } from 'vitest';

import type { LoopEmitted, TurnOutcome } from '@moonshot-ai/core/loop/index';
import {
  CoreLoopEvent,
  onCoreLoopEvent,
  onCoreTurnLifecycle,
  turnOutcomeReason,
} from '#/agent/loop/coreLoopEvent';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { EventBusService } from '#/app/event/eventBusService';

import { stubAgentContext } from '../agentContext/stubs';

describe('CoreLoopEvent', () => {
  it('declares a non-durable observable agent-domain event', () => {
    expect(CoreLoopEvent.type).toBe('core.loop.event');
    expect(CoreLoopEvent.durable).toBe(false);
    expect(CoreLoopEvent.observable).toBe(true);
    expect(CoreLoopEvent.agentDomain).toBe(true);
  });

  it('subscribes by core event type with the narrowed payload and agent envelope until disposed', () => {
    const bus = new EventBusService();
    const agent = stubAgentContext('main');
    bus.activateAgent(agent);
    try {
      const seen: Array<{ stepId: string; agentId: string; type: string }> = [];
      const subscription = onCoreLoopEvent(bus, 'step.started', (event, envelope) => {
        seen.push({ stepId: event.stepId, agentId: envelope.agentId, type: envelope.type });
      });

      bus.publish(new CoreLoopEvent({
        agentId: 'main',
        event: { type: 'turn.started', turnId: 0, trigger: 'normal' },
      }), agent);
      bus.publish(new CoreLoopEvent({
        agentId: 'main',
        event: { type: 'step.started', turnId: 0, step: 1, stepId: 'step-a' },
      }), agent);
      subscription.dispose();
      bus.publish(new CoreLoopEvent({
        agentId: 'main',
        event: { type: 'step.started', turnId: 0, step: 2, stepId: 'step-b' },
      }), agent);

      expect(seen).toEqual([{ stepId: 'step-a', agentId: 'main', type: 'core.loop.event' }]);
    } finally {
      bus.dispose();
    }
  });
});

describe('turnOutcomeReason', () => {
  it.each<[TurnOutcome, ReturnType<typeof turnOutcomeReason>]>([
    [{ type: 'done' }, 'completed'],
    [{ type: 'done', cause: { by: 'afterStep', reason: 'stop_turn' } }, 'completed'],
    [{ type: 'aborted' }, 'cancelled'],
    [{ type: 'aborted', reason: new Error('stop') }, 'cancelled'],
    [{ type: 'failed' }, 'failed'],
    [{ type: 'failed', error: new Error('boom') }, 'failed'],
    [{ type: 'blocked', at: 'turn.starting', cause: { by: 'gate', reason: 'blocked' } }, 'blocked'],
    [{ type: 'blocked', at: 'step.starting', cause: { by: 'step', reason: 'step_hook_failed' } }, 'blocked'],
  ])('maps %j to %s', (outcome, expected) => {
    expect(turnOutcomeReason(outcome)).toBe(expected);
  });
});

describe('onCoreTurnLifecycle', () => {
  function emit(bus: EventBusService, agent: AgentContext, event: LoopEmitted): void {
    bus.publish(new CoreLoopEvent({ agentId: agent.agentId, event }), agent);
  }

  function setup(handlers: Parameters<typeof onCoreTurnLifecycle>[1] = {}) {
    const bus = new EventBusService();
    const agent = stubAgentContext('main');
    bus.activateAgent(agent);
    const calls: string[] = [];
    const subscription = onCoreTurnLifecycle(bus, {
      onStarted: (turnId, envelope) => {
        calls.push(`started:${String(turnId)}:${envelope.event.type}`);
        handlers.onStarted?.(turnId, envelope);
      },
      onEnded: (event, envelope) => {
        calls.push(`ended:${String(event.turnId)}:${event.outcome.type}`);
        handlers.onEnded?.(event, envelope);
      },
    });
    return { bus, agent, calls, subscription };
  }

  it('starts a normal turn at step.started rather than turn.started and ends it at turn.ended', () => {
    const { bus, agent, calls, subscription } = setup();
    try {
      emit(bus, agent, { type: 'turn.started', turnId: 0, trigger: 'normal' });
      expect(calls).toEqual([]);

      emit(bus, agent, { type: 'step.started', turnId: 0, step: 1, stepId: 'step-1' });
      expect(calls).toEqual(['started:0:step.started']);

      emit(bus, agent, { type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });
      expect(calls).toEqual(['started:0:step.started', 'ended:0:done']);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });

  it('deduplicates multi-step turns and resumed turns per turnId', () => {
    const { bus, agent, calls, subscription } = setup();
    try {
      emit(bus, agent, { type: 'turn.started', turnId: 0, trigger: 'normal' });
      emit(bus, agent, { type: 'step.started', turnId: 0, step: 1, stepId: 'step-1' });
      emit(bus, agent, { type: 'step.started', turnId: 0, step: 2, stepId: 'step-2' });
      emit(bus, agent, { type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });

      emit(bus, agent, { type: 'turn.resumed', turnId: 1, step: 2 });
      emit(bus, agent, { type: 'step.started', turnId: 1, step: 2, stepId: 'step-2-resumed' });
      emit(bus, agent, { type: 'step.started', turnId: 1, step: 3, stepId: 'step-3-resumed' });
      emit(bus, agent, { type: 'turn.ended', turnId: 1, outcome: { type: 'aborted' } });

      expect(calls).toEqual([
        'started:0:step.started',
        'ended:0:done',
        'started:1:turn.resumed',
        'ended:1:aborted',
      ]);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });

  it('starts a promptOnly turn at turn.started and ends it without step.started', () => {
    const { bus, agent, calls, subscription } = setup();
    try {
      emit(bus, agent, { type: 'turn.started', turnId: 0, trigger: 'notify', promptOnly: true });
      emit(bus, agent, {
        type: 'turn.ended',
        turnId: 0,
        outcome: { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } },
        continuation: 'turn',
      });

      expect(calls).toEqual(['started:0:turn.started', 'ended:0:done']);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });

  it('ignores gate-blocked turns that emit turn.started and turn.ended without step.started', () => {
    const { bus, agent, calls, subscription } = setup();
    try {
      emit(bus, agent, { type: 'turn.started', turnId: 0, trigger: 'normal' });
      emit(bus, agent, {
        type: 'turn.ended',
        turnId: 0,
        outcome: { type: 'blocked', at: 'turn.starting', cause: { by: 'gate', reason: 'blocked' } },
      });
      expect(calls).toEqual([]);

      emit(bus, agent, { type: 'turn.started', turnId: 1, trigger: 'normal' });
      emit(bus, agent, { type: 'step.started', turnId: 1, step: 1, stepId: 'step-1' });
      emit(bus, agent, { type: 'turn.ended', turnId: 1, outcome: { type: 'done' } });
      expect(calls).toEqual(['started:1:step.started', 'ended:1:done']);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });

  it('ignores unannounced turns cancelled in the starting window', () => {
    const { bus, agent, calls, subscription } = setup();
    try {
      emit(bus, agent, { type: 'prompt.canceled', promptId: 'p1', canceled: true, startingTurnId: 0 });
      emit(bus, agent, { type: 'turn.ended', turnId: 0, outcome: { type: 'aborted' } });
      expect(calls).toEqual([]);

      emit(bus, agent, { type: 'turn.started', turnId: 1, trigger: 'normal' });
      emit(bus, agent, { type: 'step.started', turnId: 1, step: 1, stepId: 'step-1' });
      emit(bus, agent, { type: 'turn.ended', turnId: 1, outcome: { type: 'done' } });
      expect(calls).toEqual(['started:1:step.started', 'ended:1:done']);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });

  it('tracks active turns independently per agent and stops after disposal', () => {
    const bus = new EventBusService();
    const first = stubAgentContext('agent-a');
    const second = stubAgentContext('agent-b');
    bus.activateAgent(first);
    bus.activateAgent(second);
    const ended: string[] = [];
    const subscription = onCoreTurnLifecycle(bus, {
      onEnded: (event, envelope) => {
        ended.push(`${envelope.agentId}:${String(event.turnId)}`);
      },
    });
    try {
      emit(bus, first, { type: 'step.started', turnId: 0, step: 1, stepId: 'a-1' });
      emit(bus, second, { type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });
      expect(ended).toEqual([]);

      emit(bus, second, { type: 'turn.started', turnId: 0, trigger: 'notify', promptOnly: true });
      emit(bus, first, { type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });
      subscription.dispose();
      emit(bus, second, { type: 'turn.ended', turnId: 0, outcome: { type: 'done' } });
      expect(ended).toEqual(['agent-a:0']);
    } finally {
      subscription.dispose();
      bus.dispose();
    }
  });
});
