import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { SkillRefreshInjector } from '../../../src/agent/injection/skill-refresh';

const VARIANT = { kind: 'injection', variant: 'skills_reloaded' };

function makeAgent(initialListing: string, systemPromptSkillListing: string | undefined) {
  const state = { listing: initialListing };
  const history: unknown[] = [];
  const appendSystemReminder = vi.fn(() => {
    history.push({});
  });
  const agent = {
    skills: { registry: { getModelSkillListing: () => state.listing } },
    systemPromptSkillListing,
    context: { history, appendSystemReminder },
  } as unknown as Agent;
  return { agent, state, appendSystemReminder };
}

describe('SkillRefreshInjector', () => {
  it('does not inject while the live listing matches the system prompt baseline', async () => {
    const { agent, appendSystemReminder } = makeAgent('DISREGARD ... skill-a', 'DISREGARD ... skill-a');
    const injector = new SkillRefreshInjector(agent);

    await injector.inject();

    expect(appendSystemReminder).not.toHaveBeenCalled();
  });

  it('surfaces the updated listing once after skills change, then stays quiet', async () => {
    const { agent, state, appendSystemReminder } = makeAgent('base', 'base');
    const injector = new SkillRefreshInjector(agent);

    state.listing = 'DISREGARD ... skill-a, skill-b';
    await injector.inject();
    expect(appendSystemReminder).toHaveBeenCalledTimes(1);
    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('skill-b'),
      VARIANT,
    );

    // No further change → no repeat injection.
    await injector.inject();
    expect(appendSystemReminder).toHaveBeenCalledTimes(1);
  });

  it('re-injects when the reminder is compacted out of context', async () => {
    const { agent, state, appendSystemReminder } = makeAgent('base', 'base');
    const injector = new SkillRefreshInjector(agent);

    state.listing = 'updated';
    await injector.inject();
    expect(appendSystemReminder).toHaveBeenCalledTimes(1);

    // Compaction drops everything up to and including the reminder.
    injector.onContextCompacted(1000);
    await injector.inject();
    expect(appendSystemReminder).toHaveBeenCalledTimes(2);
  });

  it('surfaces a freshly changed listing even while a prior one is still present', async () => {
    const { agent, state, appendSystemReminder } = makeAgent('base', 'base');
    const injector = new SkillRefreshInjector(agent);

    state.listing = 'v1';
    await injector.inject();
    state.listing = 'v2';
    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledTimes(2);
    expect(appendSystemReminder).toHaveBeenLastCalledWith(expect.stringContaining('v2'), VARIANT);
  });
});
