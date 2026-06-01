/**
 * Agent.onEvent — in-process event tap.
 *
 * The local fan-out added alongside the RPC sink powers background-subagent
 * progress streaming. Its contract: deliver to every listener, stop after
 * unsubscribe, and never let a buggy listener break emission.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/rpc';
import { testAgent } from './harness/agent';

const warning = (message: string): AgentEvent => ({ type: 'warning', message });

describe('Agent.onEvent', () => {
  it('fans out to every listener and stops a listener after it unsubscribes', () => {
    const { agent } = testAgent();
    const a: string[] = [];
    const b: string[] = [];

    const unsubscribeA = agent.onEvent((event) => a.push(event.type));
    agent.onEvent((event) => b.push(event.type));

    agent.emitEvent(warning('one'));
    expect(a).toEqual(['warning']);
    expect(b).toEqual(['warning']);

    unsubscribeA();
    agent.emitEvent(warning('two'));
    expect(a).toEqual(['warning']); // unsubscribed — no further delivery
    expect(b).toEqual(['warning', 'warning']); // still subscribed
  });

  it('swallows a listener exception so siblings and emission still run', () => {
    const { agent } = testAgent();
    const seen: string[] = [];

    agent.onEvent(() => {
      throw new Error('buggy tap');
    });
    agent.onEvent((event) => seen.push(event.type));

    expect(() => {
      agent.emitEvent(warning('x'));
    }).not.toThrow();
    expect(seen).toEqual(['warning']); // sibling listener still received it
  });
});
