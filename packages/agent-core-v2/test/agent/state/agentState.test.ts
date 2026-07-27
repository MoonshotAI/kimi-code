/**
 * `state` domain — `IAgentStateService` snapshot safety over a fully
 * assembled agent scope. Registered keys hold plain data only: every
 * registered key must serialize, and the whole snapshot must stay small.
 */

import { describe, expect, it } from 'vitest';

import { IAgentStateService } from '#/agent/state/agentState';

import { createTestAgent } from '../../harness/agent';

describe('agent state snapshot (full agent scope)', () => {
  it('serializes every registered key and stays small', () => {
    const ctx = createTestAgent();
    const states = ctx.get(IAgentStateService);

    const registered = states.entries().map(([name]) => name);
    const snapshot = states.snapshot();
    expect(Object.keys(snapshot).toSorted()).toEqual(registered.toSorted());

    // The whole snapshot must be JSON-serializable and stay small.
    const json = JSON.stringify(snapshot);
    expect(json.length).toBeLessThan(5 * 1024 * 1024);
  });
});
