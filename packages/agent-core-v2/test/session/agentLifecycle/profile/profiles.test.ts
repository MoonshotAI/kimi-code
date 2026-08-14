/**
 * Scenario: the builtin agent profile contributions.
 *
 * Pins the code-defined profiles registered at module load: the default
 * `agent` profile carries TowerInit (the tower-mode entry point) and declares
 * no `subagents` allowlist. The `tower-worker` profile is contributed by the
 * tower Feature instead — see test/features/tower/workerProfile.test.ts. Run
 * with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/agentLifecycle/profile/profiles.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires TowerInit into the default profile', () => {
    const agent = profile('agent');
    expect(agent.tools).toContain('TowerInit');
    // No subagents allowlist: enforced when present, so `undefined` keeps
    // user-defined profiles delegatable, tower-worker included.
    expect(agent.subagents).toBeUndefined();
  });
});
