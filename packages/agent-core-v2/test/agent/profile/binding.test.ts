import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentWireService } from '#/wire/tokens';

import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  hostEnvironmentServices,
  type TestAgentContext,
} from '../../harness';

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
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { ctx: context, profile: svc } = buildContext();

    const catalog = context.get(IAgentProfileCatalogService);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();

    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    expect(svc.getSystemPrompt()).toContain('Kimi Code CLI');
  });

  it('persists bind bootstrap records in the v1-compatible order', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      {
        persistence,
        initialConfig: {
          thinking: { enabled: true, effort: 'low' },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentProfileService);
    await ctx.get(IAgentWireService).flush();
    const start = persistence.records.length;

    await svc.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      thinking: 'low',
      cwd: homeDir,
    });
    await ctx.get(IAgentWireService).flush();

    const records = persistence.records
      .slice(start)
      .filter(
        (record) =>
          record.type === 'config.update' || record.type === 'tools.set_active_tools',
      );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      type: 'config.update',
      cwd: homeDir,
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      systemPrompt: expect.stringContaining('Kimi Code CLI'),
    });
    expect(records[0]).not.toHaveProperty('modelAlias');
    expect(records[0]).not.toHaveProperty('thinkingEffort');
    expect(records[1]).toMatchObject({
      type: 'tools.set_active_tools',
      names: expect.arrayContaining(['Read', 'Write', 'Bash']),
    });
    expect(records[2]).toMatchObject({
      type: 'config.update',
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'low',
    });
    expect(records[2]).not.toHaveProperty('thinkingLevel');
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
