import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../src/rpc/events';

import { testAgent } from './harness/agent';

describe('Agent.onEvent', () => {
  it('delivers emitted events to in-process listeners', () => {
    const ctx = testAgent();
    const events: AgentEvent[] = [];
    ctx.agent.onEvent((event) => {
      events.push(event);
    });

    ctx.agent.emitEvent({ type: 'warning', message: 'heads up' });

    expect(events).toEqual([{ type: 'warning', message: 'heads up' }]);
  });

  it('stops delivery after unsubscribe', () => {
    const ctx = testAgent();
    const events: AgentEvent[] = [];
    const unsubscribe = ctx.agent.onEvent((event) => {
      events.push(event);
    });

    ctx.agent.emitEvent({ type: 'warning', message: 'first' });
    unsubscribe();
    ctx.agent.emitEvent({ type: 'warning', message: 'second' });

    expect(events).toHaveLength(1);
  });

  it('keeps the agent loop and other listeners alive when a listener throws', () => {
    const ctx = testAgent();
    const events: AgentEvent[] = [];
    ctx.agent.onEvent(() => {
      throw new Error('listener boom');
    });
    ctx.agent.onEvent((event) => {
      events.push(event);
    });

    expect(() => {
      ctx.agent.emitEvent({ type: 'warning', message: 'still delivered' });
    }).not.toThrow();
    expect(events).toEqual([{ type: 'warning', message: 'still delivered' }]);
  });
});
