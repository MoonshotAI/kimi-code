import { describe, expect, it } from 'vitest';

import { IAgentStateService } from '#/agent/state/agentState';

import { createTestAgent } from '../../harness/agent';
import { BUILTIN_REPLAYABLE_STATE_KEYS } from '../../state/builtinReplayableKeys';

describe('agent state snapshot (full agent scope)', () => {
  it('serializes every registered key and stays small', () => {
    const ctx = createTestAgent();
    const states = ctx.get(IAgentStateService);

    const excluded = new Set(BUILTIN_REPLAYABLE_STATE_KEYS.map((key) => key.name));
    const registered = states.entries().map(([name]) => name);
    const snapshot = states.snapshot();
    expect(Object.keys(snapshot).toSorted()).toEqual(
      registered.filter((name) => !excluded.has(name)).toSorted(),
    );
    for (const name of excluded) {
      expect(snapshot[name]).toBeUndefined();
    }

    const json = JSON.stringify(snapshot);
    expect(json.length).toBeLessThan(5 * 1024 * 1024);
  });
});
