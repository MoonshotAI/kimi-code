/**
 * Scenario: the builtin agent profile contributions.
 *
 * Pins the code-defined profiles registered at module load: the default
 * `agent` profile carries TowerInit and declares the `tower-worker` subagent
 * type, and the `tower-worker` profile mirrors the v1 `extends: coder` shape —
 * the coder base role plus the tower overlay, the coder tool set (minus
 * `AgentSwarm`: the tower is the sole orchestrator, and worker-side swarm
 * fan-out runs unbudgeted and outside the worktree/roster discipline) plus
 * the six shared tower protocol tools, and the coder summary policy. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
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
  it('wires the tower-worker profile into the default set', () => {
    const agent = profile('agent');
    expect(agent.tools).toContain('TowerInit');
    // No subagents allowlist: enforced when present, so `undefined` keeps
    // user-defined profiles delegatable, tower-worker included.
    expect(agent.subagents).toBeUndefined();
  });

  it('gives tower-worker the coder tools (minus AgentSwarm) plus the six shared tower tools', () => {
    const coder = profile('coder');
    const towerWorker = profile('tower-worker');
    const tools = towerWorker.tools ?? [];

    for (const name of coder.tools ?? []) {
      if (name === 'AgentSwarm') continue;
      expect(tools).toContain(name);
    }
    // Workers never fan out a swarm: the tower is the sole orchestrator, and
    // swarm children would run unbudgeted on the main checkout, bypassing the
    // worktree/roster discipline and the review-gated merge protocol.
    expect(tools).not.toContain('AgentSwarm');
    // v2 enforces the delegation allowlist, so workers keep `Agent` but may
    // only spawn read-only profiles — a write-capable child would run on the
    // main checkout outside the roster and the write guard.
    expect(towerWorker.subagents).toEqual(['explore', 'plan']);
    for (const name of [
      'TowerSend',
      'TowerInbox',
      'TowerFinding',
      'TowerReview',
      'TowerMission',
      'TowerStatus',
    ]) {
      expect(tools).toContain(name);
    }
    // Tower tools stay with the main agent; workers get the shared set only.
    for (const name of ['TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerTeardown']) {
      expect(tools).not.toContain(name);
    }
  });

  it('renders the coder base role plus the tower worker overlay', () => {
    const prompt = profile('tower-worker').systemPrompt({});
    expect(prompt).toContain('tower worker/reviewer');
    expect(prompt).toContain('Tower* tools ONLY');
    // The coder base: subagent prefix and the final-message handoff contract.
    expect(prompt).toContain('You are now running as a subagent.');
    expect(prompt).toContain('Your final message is the entire handoff');
  });

  it('keeps the coder summary policy and ports the description', () => {
    const coder = profile('coder');
    const towerWorker = profile('tower-worker');
    expect(towerWorker.summaryPolicy).toEqual(coder.summaryPolicy);
    expect(towerWorker.summaryPolicy).toBeDefined();
    expect(towerWorker.description).toContain('Tower worker/reviewer');
    expect(towerWorker.whenToUse).toBe(coder.whenToUse);
  });
});
