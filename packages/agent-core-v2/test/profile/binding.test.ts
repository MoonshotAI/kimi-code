import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';

import { createTestAgent, hostEnvironmentServices, type TestAgentContext } from '../harness';

const MOCK_MODEL = 'mock-model';

describe('AgentProfileService.bind', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-bind-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildContext(): { ctx: TestAgentContext; profile: IAgentProfileService } {
    // Hermetic home dir so a developer's real ~/.kimi-code / ~/.agents files
    // never leak into the rendered system prompt.
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { ctx: context, profile: svc } = buildContext();

    // Sanity: the builtin default profile is registered in the catalog.
    const catalog = context.get(IAgentProfileCatalogService);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();

    // Auto-configure sets a model alias but no profile, so the agent is not
    // runnable until a profile is bound (no default agent).
    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    // The rendered system prompt is the full base template (not an overlay).
    expect(svc.getSystemPrompt()).toContain('Kimi Code CLI');
  });

  it('setModel applies the default profile when none is bound yet', async () => {
    const { profile: svc } = buildContext();

    expect(svc.data().profileName).toBeUndefined();

    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('setModel keeps the existing profile when one is already bound', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });
});
