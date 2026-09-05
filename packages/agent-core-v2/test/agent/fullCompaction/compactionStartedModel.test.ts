import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentProfileService } from '#/index';
import { COMPACTION_MODEL_FLAG_ENV } from '#/session/compaction/flag';
import { testAgent } from '../../harness';

const PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;

const MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const DEDICATED_MODEL = {
  provider: 'test-provider',
  model: 'compaction-model',
  maxContextSize: 256_000,
  capabilities: ['thinking', 'tool_use'],
} as const;

const SECONDARY_MODEL = {
  provider: 'test-provider',
  model: 'backup-model',
  maxContextSize: 256_000,
  capabilities: ['thinking', 'tool_use'],
} as const;

interface StartedModelArgs {
  readonly model?: string;
  readonly model_display?: string;
}

function findStartedModel(ctx: ReturnType<typeof testAgent>): StartedModelArgs {
  const events = ctx.newEvents() as unknown as Array<{
    readonly type?: string;
    readonly event?: string;
    readonly args?: unknown;
  }>;
  const event = events.find((e) => e.type === '[rpc]' && e.event === 'compaction.started');
  return (event?.args as StartedModelArgs | undefined) ?? {};
}

function makeAgent(initialConfig: Record<string, unknown> = {}) {
  const ctx = testAgent({
    initialConfig: {
      providers: {},
      models: {
        'kimi/compaction': DEDICATED_MODEL,
        'kimi/backup': SECONDARY_MODEL,
      },
      ...initialConfig,
    },
  });
  ctx.configure({ provider: PROVIDER, modelCapabilities: MODEL_CAPABILITIES });
  return ctx;
}

async function runCompaction(ctx: ReturnType<typeof testAgent>): Promise<void> {
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  const completed = ctx.once('compaction.completed');
  ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
  await ctx.rpc.beginCompaction({ instruction: undefined });
  await completed;
}

describe('FullCompaction started model', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('carries the current model alias when no dedicated compaction model is configured', async () => {
    const ctx = makeAgent();
    const expectedAlias = ctx.get(IAgentProfileService).resolveModelContext().modelAlias;
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe(expectedAlias);
    expect(model_display).toBe(expectedAlias);
  });

  it('carries the dedicated compaction model when [compaction_model] is configured', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({ compactionModel: { model: 'kimi/compaction' } });
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe('kimi/compaction');
    expect(model_display).toBe('kimi/compaction');
  });

  it('honors the legacy default_model pointer written by an older TUI', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({ compactionModel: { defaultModel: 'kimi/compaction' } });
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe('kimi/compaction');
    expect(model_display).toBe('kimi/compaction');
  });

  it('cascades to the secondary squeeze model when the primary is unresolvable', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({ compactionModel: { model: 'kimi/ghost', secondaryModel: 'kimi/backup' } });
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe('kimi/backup');
    expect(model_display).toBe('kimi/backup');
  });

  it('uses the secondary squeeze model when no primary is configured', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({ compactionModel: { secondaryModel: 'kimi/backup' } });
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe('kimi/backup');
    expect(model_display).toBe('kimi/backup');
  });

  it('falls back to the current model when both squeeze tiers are unresolvable', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({
      compactionModel: { model: 'kimi/ghost', secondaryModel: 'kimi/phantom' },
    });
    const expectedAlias = ctx.get(IAgentProfileService).resolveModelContext().modelAlias;
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe(expectedAlias);
    expect(model_display).toBe(expectedAlias);
  });

  it('prefers the primary squeeze model when both tiers resolve', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const ctx = makeAgent({
      compactionModel: { model: 'kimi/compaction', secondaryModel: 'kimi/backup' },
    });
    await runCompaction(ctx);

    const { model, model_display } = findStartedModel(ctx);
    expect(model).toBe('kimi/compaction');
    expect(model_display).toBe('kimi/compaction');
  });
});
