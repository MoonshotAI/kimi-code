/**
 * `state` domain — `IAgentStateService` snapshot safety over a fully
 * assembled agent scope. Guards the regression where `snapshot()` deep-copied
 * resource graphs reachable from registered values (built-in tool instances
 * hold service references) until the process ran out of heap: every
 * registered key must serialize, and class instances must collapse to
 * `'(ClassName)'` markers instead of being recursed.
 */

import { describe, expect, it } from 'vitest';

import { IAgentStateService } from '#/agent/state/agentState';
import { toolRegistryToolsKey } from '#/agent/toolRegistry/toolRegistryService';

import { createTestAgent } from '../../harness/agent';

describe('agent state snapshot (full agent scope)', () => {
  it('serializes every registered key and collapses class instances to markers', () => {
    const ctx = createTestAgent();
    const states = ctx.get(IAgentStateService);

    const registered = states.entries().map(([name]) => name);
    const snapshot = states.snapshot();
    expect(Object.keys(snapshot).toSorted()).toEqual(registered.toSorted());

    // The whole snapshot must be JSON-serializable and stay small — before
    // the class-instance guard, `toolRegistry.tools` alone deep-copied to
    // hundreds of MB.
    const json = JSON.stringify(snapshot);
    expect(json.length).toBeLessThan(5 * 1024 * 1024);

    const tools = snapshot[toolRegistryToolsKey.name] as Record<string, unknown>;
    const entries = Object.values(tools) as { tool?: unknown }[];
    expect(entries.length).toBeGreaterThan(0);
    // Built-in tools are class instances → '(BashTool)' markers on the entry's
    // `tool` property; literal tool objects keep recursing. At least one
    // marker must be present.
    expect(
      entries.some(
        (entry) => typeof entry.tool === 'string' && /^\(.+Tool\)$/.test(entry.tool),
      ),
    ).toBe(true);
  });
});
