import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentModelSnapshotService } from '#/agent/modelSnapshot/modelSnapshot';
import { IAgentProfileService } from '#/agent/profile/profile';
import { WIRE_PROTOCOL_VERSION } from '#/index';
import type { WireRecord } from '#/wire/record';

import {
  configServices,
  createTestAgent,
  InMemoryWireRecordPersistence,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../../harness';

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [] };
}

function snapshotRecords(records: readonly WireRecord[]): WireRecord[] {
  return records.filter((record) => record.type === 'model.snapshot');
}

function warningEvents(ctx: TestAgentContext) {
  return ctx.allEvents.filter((entry) => entry.event === 'warning');
}

describe('AgentModelSnapshotService', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('writes a snapshot on successful resolution and skips rewrites while unchanged', async () => {
    profile.resolveModelContext();
    let records = await ctx.persistedWireRecords();
    const written = snapshotRecords(records);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      alias: 'mock-model',
      record: {
        provider: 'test-provider',
        model: 'mock-model',
        maxContextSize: 1_000_000,
      },
    });
    expect(JSON.stringify(written[0])).not.toMatch(/api_?key|token|authorization|headers/i);

    profile.resolveModelContext();
    ctx.get(IAgentModelSnapshotService).resolveRequester('mock-model');
    records = await ctx.persistedWireRecords();
    expect(snapshotRecords(records)).toHaveLength(1);
  });

  it('falls back to the snapshot when the alias disappears from config, warning once', async () => {
    profile.resolveModelContext();
    ctx.kimiConfig = { ...ctx.kimiConfig, models: {} };

    const resolved = profile.resolveModelContext();
    expect(resolved.modelAlias).toBe('mock-model');
    expect(resolved.modelCapabilities.max_context_tokens).toBe(1_000_000);
    expect(warningEvents(ctx)).toHaveLength(1);
    expect(warningEvents(ctx)[0]?.args).toMatchObject({ code: 'model-snapshot-fallback' });

    profile.resolveModelContext();
    expect(warningEvents(ctx)).toHaveLength(1);
  });

  it('serves requests through the snapshot after the alias disappears', async () => {
    profile.resolveModelContext();
    ctx.kimiConfig = { ...ctx.kimiConfig, models: {} };

    ctx.mockNextResponse({ type: 'text', text: 'fallback works' });
    const finish = await ctx.get(IAgentLLMRequesterService).request({
      messages: [userMessage('hi')],
      systemPrompt: 'sys',
    });
    expect(finish.message.content).toEqual([{ type: 'text', text: 'fallback works' }]);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('keeps failing loud when the provider is gone too', async () => {
    profile.resolveModelContext();
    ctx.kimiConfig = { ...ctx.kimiConfig, models: {}, providers: {} };

    let thrown: unknown;
    try {
      profile.resolveModelContext();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toSatisfy((e) => isError2(e) && e.code === 'config.invalid');
    expect(warningEvents(ctx)).toHaveLength(0);
  });

  it('does not snapshot models carrying inline apiKey auth', async () => {
    const flatModels = {
      flat: {
        model: 'flat-model',
        baseUrl: 'https://flat.example.test/v1',
        apiKey: 'sk-flat',
        protocol: 'openai',
        maxContextSize: 8192,
      },
    } as unknown as TestAgentContext['kimiConfig']['models'];
    ctx.kimiConfig = { ...ctx.kimiConfig, models: flatModels };
    profile.update({ modelAlias: 'flat' });

    profile.resolveModelContext();

    const records = await ctx.persistedWireRecords();
    expect(snapshotRecords(records)).toHaveLength(0);
  });

  it('refreshes the snapshot when the alias config changes', async () => {
    profile.resolveModelContext();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        'mock-model': {
          provider: 'test-provider',
          model: 'mock-model',
          maxContextSize: 500_000,
          capabilities: [],
        },
      },
    };

    const resolved = profile.resolveModelContext();
    expect(resolved.modelCapabilities.max_context_tokens).toBe(500_000);

    const records = await ctx.persistedWireRecords();
    const written = snapshotRecords(records);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ record: { maxContextSize: 500_000 } });
  });

  it('pins the resolved default provider into the snapshot', async () => {
    const snapshots = ctx.get(IAgentModelSnapshotService);
    const models = {
      routed: { model: 'routed-model', maxContextSize: 64_000 },
    } as unknown as TestAgentContext['kimiConfig']['models'];
    ctx.kimiConfig = {
      providers: {
        'provider-a': { type: 'kimi', apiKey: 'key-a', baseUrl: 'https://a.example.test/v1' },
        'provider-b': { type: 'kimi', apiKey: 'key-b', baseUrl: 'https://b.example.test/v1' },
      },
      defaultProvider: 'provider-a',
      models,
    };
    profile.update({ modelAlias: 'routed' });
    profile.resolveModelContext();

    const written = snapshotRecords(await ctx.persistedWireRecords());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ alias: 'routed', record: { provider: 'provider-a' } });

    ctx.kimiConfig = { ...ctx.kimiConfig, models: {}, defaultProvider: 'provider-b' };
    const resolved = snapshots.resolve('routed');
    expect(resolved.providerName).toBe('provider-a');
    expect(resolved.baseUrl).toBe('https://a.example.test/v1');

    ctx.kimiConfig = {
      providers: {
        'provider-b': { type: 'kimi', apiKey: 'key-b', baseUrl: 'https://b.example.test/v1' },
      },
      defaultProvider: 'provider-b',
      models: {},
    };
    let thrown: unknown;
    try {
      snapshots.resolve('routed');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toSatisfy((e) => isError2(e) && e.code === 'config.invalid');
  });

  it('keeps flat models flat when a default provider appears after the snapshot', async () => {
    const snapshots = ctx.get(IAgentModelSnapshotService);
    const models = {
      flat: {
        model: 'flat-model',
        baseUrl: 'https://flat.example.test/v1',
        protocol: 'openai',
        maxContextSize: 8192,
      },
    } as unknown as TestAgentContext['kimiConfig']['models'];
    ctx.kimiConfig = {
      providers: {
        'late-default': { type: 'kimi', apiKey: 'key-late', baseUrl: 'https://late.example.test/v1' },
      },
      models,
    };
    profile.update({ modelAlias: 'flat' });
    profile.resolveModelContext();

    const written = snapshotRecords(await ctx.persistedWireRecords());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ alias: 'flat' });
    expect((written[0]?.['record'] as Record<string, unknown>)['provider']).toBeUndefined();

    ctx.kimiConfig = { ...ctx.kimiConfig, models: {}, defaultProvider: 'late-default' };
    const resolved = snapshots.resolve('flat');
    expect(resolved.providerName).toBe('flat.example.test');
    expect(resolved.baseUrl).toBe('https://flat.example.test/v1');
  });

  it('resolves after resume via the persisted snapshot when the alias is gone from config', async () => {
    const source = createTestAgent({ persistence: new InMemoryWireRecordPersistence() });
    let records: readonly WireRecord[];
    try {
      source.get(IAgentProfileService).resolveModelContext();
      records = await source.persistedWireRecords();
    } finally {
      await source.dispose();
    }
    const seeded: WireRecord[] =
      records[0]?.type === 'metadata'
        ? [...records]
        : [
            { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
            ...records,
          ];
    const resumedConfig = {
      providers: {
        'test-provider': {
          type: 'kimi',
          apiKey: 'test-key',
          baseUrl: 'https://api.example.test/v1',
        },
      },
      models: {},
    };
    const resumed = createTestAgent(
      { autoConfigure: false },
      configServices(() => resumedConfig),
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(seeded)),
    );
    try {
      await resumed.restorePersisted();
      const resolved = resumed.get(IAgentProfileService).resolveModelContext();
      expect(resolved.modelAlias).toBe('mock-model');
      expect(resolved.modelCapabilities.max_context_tokens).toBe(1_000_000);
      expect(warningEvents(resumed)).toHaveLength(1);
    } finally {
      await resumed.dispose();
    }
  });
});
