/**
 * Scenario: `compaction.started` must surface the model the compaction will use.
 * The started indicator shows the intended model (resolved before the
 * `full_compaction.begin` record is logged), so the TUI can render
 * "Compacting context using <model>...". The dedicated `[compaction_model]` model
 * is carried when configured; otherwise the active conversation model is.
 * The payload fields are snake_case (`model`, `model_display`) so they survive
 * the klient/protocol event validation on the way to the TUI.
 * Run: pnpm -C packages/agent-core-v2 exec vitest run test/agent/fullCompaction/compactionStartedModel.test.ts
 */
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
});