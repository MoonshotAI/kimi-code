import { describe, expect, it } from 'vitest';

import type { TurnOutcome } from '@moonshot-ai/core/loop/index';
import { CoreLoopEvent, onCoreLoopEvent, turnOutcomeReason } from '#/agent/loop/coreLoopEvent';
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
