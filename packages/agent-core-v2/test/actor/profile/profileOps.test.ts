import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { AgentProfile, type ProfileRuntime } from '#/actor/profile/profileAgentRuntime';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ModelRecord } from '#/kosong/model/model';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import {
  configServices,
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

const DISCLOSURE: EnvironmentDisclosureSnapshot = {
  cwd: '/work',
  date: {
    disclosed: true,
    value: { localDate: '2026-07-29', timeZone: 'Asia/Shanghai' },
  },
};

type TestKimiConfig = ReturnType<Parameters<typeof configServices>[0]>;
type TestProtocolModelConfig = NonNullable<TestKimiConfig['models']>[string] &
  Pick<ModelRecord, 'protocol'>;

function profileRecords(
  persistence: InMemoryWireRecordPersistence,
  type: string,
): WireRecord[] {
  return persistence.records.filter((record) => record.type === type);
}

async function flush(ctx: TestAgentContext): Promise<void> {
  await ctx.get(IWireService).flush();
}

describe('ProfileRuntime durable config.update', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('update persists flat config.update records and resolves thinkingLevel as wire thinkingEffort at the call site', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence, autoConfigure: false });
    const profile = ctx.resolve(AgentProfile);

    profile.update({ profileName: 'coder', systemPrompt: 'You are helpful.' });
    profile.update({ thinkingLevel: 'on' });

    expect(profile.data()).toMatchObject({
      profileName: 'coder',
      systemPrompt: 'You are helpful.',
      thinkingLevel: 'on',
    });
    expect(profile.systemPrompt()).toBe('You are helpful.');

    await flush(ctx);
    expect(profileRecords(persistence, 'config.update')).toEqual([
      {
        type: 'config.update',
        agentId: 'main',
        profileName: 'coder',
        systemPrompt: 'You are helpful.',
        time: expect.any(Number),
      },
      { type: 'config.update', agentId: 'main', thinkingEffort: 'on', time: expect.any(Number) },
    ]);
    expect(profileRecords(persistence, 'config.update').every((r) => !('payload' in r))).toBe(true);
  });

  it('re-dispatching an equal config leaves the projection unchanged', () => {
    ctx = createTestAgent({ autoConfigure: false });
    const profile = ctx.resolve(AgentProfile);

    profile.update({ profileName: 'coder' });
    const before = profile.data();
    profile.update({ profileName: 'coder' });
    expect(profile.data()).toEqual(before);
  });

  it('persists and replays an allowlist reset to unrestricted', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence, autoConfigure: false });
    try {
      const profile = live.resolve(AgentProfile);
      profile.applyData({
        modelCapabilities: UNKNOWN_CAPABILITY,
        profileName: 'restricted',
        thinkingLevel: 'off',
        systemPrompt: 'restricted',
        activeToolNames: ['Read'],
        disallowedTools: [],
      });
      profile.applyData({
        modelCapabilities: UNKNOWN_CAPABILITY,
        profileName: 'unrestricted',
        thinkingLevel: 'off',
        systemPrompt: 'unrestricted',
        activeToolNames: undefined,
        disallowedTools: [],
      });
      expect(profile.activeTools()).toBeUndefined();
      await flush(live);
    } finally {
      await live.dispose();
    }

    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    const replayed = ctx.resolve(AgentProfile);
    expect(replayed.activeTools()).toBeUndefined();
    expect(replayed.data().profileName).toBe('unrestricted');
  });

  it('persists the rendered prompt and disclosure snapshot in one bind record', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence, autoConfigure: false });
    try {
      live.resolve(AgentProfile).applyData({
        modelCapabilities: UNKNOWN_CAPABILITY,
        modelAlias: 'kimi-code',
        profileName: 'agent',
        thinkingLevel: 'off',
        systemPrompt: 'rendered prompt',
        environmentDisclosure: DISCLOSURE,
        renderGeneration: 7,
        activeToolNames: undefined,
        disallowedTools: [],
      });
      await flush(live);
    } finally {
      await live.dispose();
    }

    expect(profileRecords(persistence, 'profile.bind')).toEqual([
      expect.objectContaining({
        type: 'profile.bind',
        systemPrompt: 'rendered prompt',
        environmentDisclosure: DISCLOSURE,
        renderGeneration: 7,
      }),
    ]);
    expect(profileRecords(persistence, 'config.update')).toHaveLength(0);

    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    expect(ctx.resolve(AgentProfile).data()).toMatchObject({
      systemPrompt: 'rendered prompt',
      environmentDisclosure: DISCLOSURE,
      renderGeneration: 7,
    });
  });

  it('replays a legacy config.update record with an explicit renderGeneration verbatim', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'config.update',
        agentId: 'main',
        systemPrompt: 'legacy prompt',
        environmentDisclosure: DISCLOSURE,
        renderGeneration: 100,
        time: 1,
      },
    ]);
    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();

    expect(ctx.resolve(AgentProfile).data()).toMatchObject({
      systemPrompt: 'legacy prompt',
      environmentDisclosure: DISCLOSURE,
      renderGeneration: 100,
    });
  });

  it('replay rebuilds the resolved thinkingLevel without re-reading config', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence, autoConfigure: false });
    try {
      live.resolve(AgentProfile).update({ thinkingLevel: 'on' });
      await flush(live);
    } finally {
      await live.dispose();
    }

    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();
    expect(ctx.resolve(AgentProfile).data().thinkingLevel).toBe('on');
  });

  it('replays legacy config.update thinkingLevel records', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      { type: 'config.update', agentId: 'main', thinkingLevel: 'high', time: 1 },
    ]);
    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();

    expect(ctx.resolve(AgentProfile).data().thinkingLevel).toBe('high');
  });

  it('returns the persisted effort when a replayed model alias no longer resolves', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'config.update',
        agentId: 'main',
        modelAlias: 'removed-model',
        thinkingEffort: 'high',
        time: 1,
      },
    ]);
    ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.restorePersisted();

    expect(ctx.resolve(AgentProfile).effectiveThinkingLevel()).toBe('high');
  });

  it('rejects conflicting config.update thinking aliases during replay', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'config.update',
        agentId: 'main',
        thinkingEffort: 'low',
        thinkingLevel: 'high',
        time: 1,
      },
    ]);
    ctx = createTestAgent({ persistence, autoConfigure: false });

    await expect(ctx.restorePersisted()).rejects.toMatchObject({
      code: 'profile.thinking_alias_conflict',
      name: 'ProfileError',
    });
  });

  it('emits agent.status.updated live-only and appends nothing during replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence, autoConfigure: false });
    let liveEmits = 0;
    live.get(IEventBus).subscribe(AgentStatusUpdated, () => {
      liveEmits += 1;
    });
    try {
      const profile = live.resolve(AgentProfile);
      profile.update({ profileName: 'coder', modelAlias: 'mock-model' });
      expect(liveEmits).toBe(1);
      await flush(live);
    } finally {
      await live.dispose();
    }
    const written = persistence.records.filter((record) => record.type !== 'metadata');

    ctx = createTestAgent({ persistence, autoConfigure: false });
    let replayEmits = 0;
    ctx.get(IEventBus).subscribe(AgentStatusUpdated, () => {
      replayEmits += 1;
    });
    await ctx.restorePersisted();

    expect(ctx.resolve(AgentProfile).data().profileName).toBe('coder');
    expect(replayEmits).toBe(0);
    expect(
      persistence.records.filter(
        (record) => record.type !== 'metadata' && record.type !== 'runtime.set_binding',
      ),
    ).toEqual(written);
  });
});

describe('ProfileRuntime request params and thinking resolution', () => {
  let ctx: TestAgentContext | undefined;
  let kimiConfig: TestKimiConfig;

  function buildContext(): ProfileRuntime {
    ctx = createTestAgent(configServices(() => kimiConfig));
    return ctx.resolve(AgentProfile);
  }

  function kimiProvider(): NonNullable<TestKimiConfig['providers']> {
    return {
      kimi: {
        type: 'kimi',
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test/v1',
      },
    };
  }

  function kimiModel(
    options: {
      readonly protocol?: string;
      readonly supportEfforts?: readonly string[];
      readonly defaultEffort?: string;
    } = {},
  ): TestProtocolModelConfig {
    return {
      provider: 'kimi',
      model: 'kimi-for-coding',
      maxContextSize: 1000,
      capabilities: ['thinking'],
      protocol: options.protocol,
      supportEfforts: options.supportEfforts,
      defaultEffort: options.defaultEffort,
    } as TestProtocolModelConfig;
  }

  beforeEach(() => {
    kimiConfig = { providers: {}, models: {} };
  });

  afterEach(async () => {
    try {
      await ctx?.expectResumeMatches();
    } finally {
      await ctx?.dispose();
      ctx = undefined;
    }
  });

  it('applies thinking.keep model override when thinking is enabled', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
      modelOverrides: { temperature: 0.3, thinkingKeep: 'all' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      sampling: { temperature: 0.3 },
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('uses the resolved Kimi effort instead of the configured default', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
      thinking: { effort: ' max ' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('forces the environment Kimi effort instead of the resolved effort', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
      thinking: { effort: 'low', forcedEffort: ' max ' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.data().thinkingLevel).toBe('high');
    expect(profile.modelContext().thinkingLevel).toBe('max');
    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      thinkingEffort: 'max',
      thinkingKeep: 'all',
    });
  });

  it('does not leak a forced Kimi effort when switching to a non-Kimi model', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: {
        'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }),
        'other-code': {
          ...kimiModel({ protocol: 'anthropic' }),
          provider: 'other',
        },
      },
      thinking: { forcedEffort: 'max' },
    };
    kimiConfig.providers!['other'] = {
      type: 'other',
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test/v1',
    };
    const profile = buildContext();

    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });
    expect(profile.data().thinkingLevel).toBe('high');
    expect(profile.modelContext().thinkingLevel).toBe('max');
    expect(profile.requestParams().thinkingEffort).toBe('max');

    profile.update({ modelAlias: 'other-code' });
    expect(profile.data().thinkingLevel).toBe('high');
    expect(profile.modelContext().thinkingLevel).toBe('high');
    expect(profile.requestParams().thinkingEffort).toBe('high');
  });

  it('applies thinking.keep model override on the Anthropic path', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'claude-code': kimiModel({ protocol: 'anthropic' }) },
      modelOverrides: { temperature: 0.3, thinkingKeep: 'all' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });

    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      sampling: { temperature: 0.3 },
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('forces Kimi effort through Anthropic without Kimi generation kwargs', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: {
        'kimi-code': kimiModel({ protocol: 'anthropic', supportEfforts: ['low', 'high', 'max'] }),
      },
      thinking: { forcedEffort: 'max' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.modelContext().thinkingLevel).toBe('max');
    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      thinkingEffort: 'max',
      thinkingKeep: 'all',
    });
  });

  it('defaults thinking.keep to "all" when thinking is enabled on Kimi', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      thinkingEffort: 'high',
      thinkingKeep: 'all',
    });
  });

  it('treats an off env thinking.keep override as disabled on Kimi', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
      modelOverrides: { thinkingKeep: 'off' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    const params = profile.requestParams();
    expect(params.thinkingEffort).toBe('high');
    expect(params.thinkingKeep).toBeUndefined();
  });

  it('applies config thinking.keep on the Anthropic path', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'claude-code': kimiModel({ protocol: 'anthropic' }) },
      thinking: { keep: 'config-keep' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'claude-code', thinkingLevel: 'high' });

    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      thinkingEffort: 'high',
      thinkingKeep: 'config-keep',
    });
  });

  it('does not apply thinking.keep model override when thinking is off', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
      thinking: { forcedEffort: 'max' },
      modelOverrides: { temperature: 0.3, thinkingKeep: 'all' },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'off' });

    expect(profile.modelContext().thinkingLevel).toBe('off');
    expect(profile.requestParams()).toEqual({
      cacheKey: ctx!.get(ISessionContext).sessionId,
      sampling: { temperature: 0.3 },
      thinkingEffort: 'off',
      thinkingKeep: undefined,
    });
  });

  it('uses the session id as a Kimi prompt cache hint', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'kimi-code': kimiModel({ supportEfforts: ['low', 'medium', 'high', 'max'] }) },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'kimi-code', thinkingLevel: 'high' });

    expect(profile.requestParams().cacheKey).toBe(ctx!.get(ISessionContext).sessionId);
  });

  it('resolves the session cache-key intent for non-Kimi protocols too', () => {
    kimiConfig = {
      providers: kimiProvider(),
      models: { 'claude-sonnet': kimiModel({ protocol: 'anthropic' }) },
    };
    const profile = buildContext();
    profile.update({ modelAlias: 'claude-sonnet', thinkingLevel: 'high' });

    expect(profile.requestParams().cacheKey).toBe(ctx!.get(ISessionContext).sessionId);
  });
});
