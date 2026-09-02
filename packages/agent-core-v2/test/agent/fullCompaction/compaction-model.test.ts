
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APIConnectionError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import { COMPACTION_MODEL_FLAG_ENV } from '#/session/compaction/flag';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { llmGenerateServices, testAgent, type TestAgentOptions } from '../../harness';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

const PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1',
  model: 'kimi-code',
} as const;

const MODEL_CAPABILITIES = {
  image_in: false,
  video_in: false,
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

function compactionFinished(records: readonly TelemetryRecord[]): TelemetryRecord | undefined {
  return records.find((record) => record.event === 'compaction_finished');
}

function makeAgent(options: {
  readonly initialConfig?: Record<string, unknown>;
  readonly generate?: GenerateFn;
} = {}) {
  const records: TelemetryRecord[] = [];
  const ctx = testAgent(
    ...(options.generate !== undefined ? [llmGenerateServices(options.generate)] : []),
    {
      telemetry: recordingTelemetry(records),
      initialConfig: {
        providers: {},
        models: {
          'kimi/compaction': DEDICATED_MODEL,
        },
        ...options.initialConfig,
      },
    },
  );
  ctx.configure({ provider: PROVIDER, modelCapabilities: MODEL_CAPABILITIES });
  return { ctx, records };
}

function seedHistory(ctx: ReturnType<typeof makeAgent>['ctx']): void {
  ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
  ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
  ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
}

async function runManualCompaction(
  ctx: ReturnType<typeof makeAgent>['ctx'],
  records: readonly TelemetryRecord[],
  text = 'Compacted summary.',
): Promise<void> {
  const completed = ctx.once('compaction.completed');
  ctx.mockNextResponse({ type: 'text', text });
  await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
  await Promise.race([
    completed,
    new Promise<void>((_, reject) =>
      setTimeout(
        () => {
          reject(
            new Error(
              `timeout; events=${JSON.stringify(records.map((r) => r.event))}`,
            ),
          );
        },
        8000,
      ),
    ),
  ]);
}

describe('FullCompaction — dedicated compaction model', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the dedicated model when the flag is on and [compaction_model] is set', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const { ctx, records } = makeAgent({ initialConfig: { compactionModel: { model: 'kimi/compaction' } } });
    seedHistory(ctx);

    await runManualCompaction(ctx, records);

    const finished = compactionFinished(records);
    expect(finished).toBeDefined();
    expect(finished?.properties?.['model']).toBe('kimi/compaction');
    expect(finished?.properties?.['model_display']).toBe('kimi/compaction');
  });

  it('falls back to the current model when the dedicated model is inaccessible', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const { ctx, records } = makeAgent({
      initialConfig: { compactionModel: { model: 'kimi/ghost' } },
    });
    seedHistory(ctx);

    await runManualCompaction(ctx, records);

    const finished = compactionFinished(records);
    expect(finished).toBeDefined();
    expect(finished?.properties?.['model']).toBe('kimi-code');
  });

  it('falls back to the current model when the dedicated model errors on the first call', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    let callCount = 0;
    const generate: GenerateFn = async (_chat, _systemPrompt, _tools, _history, _callbacks, options) => {
      options?.signal?.throwIfAborted();
      callCount += 1;
      if (callCount === 1) {
        throw new APIConnectionError('simulated connection failure');
      }
      const message: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Compacted summary.' }],
        toolCalls: [],
      };
      options?.onStreamEnd?.();
      return {
        id: 'mock-fallback',
        message,
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
        traceId: null,
      };
    };
    const { ctx, records } = makeAgent({
      generate,
      initialConfig: { compactionModel: { model: 'kimi/compaction' } },
    });
    seedHistory(ctx);

    await runManualCompaction(ctx, records);

    expect(callCount).toBe(2);
    const finished = compactionFinished(records);
    expect(finished).toBeDefined();
    expect(finished?.properties?.['model']).toBe('kimi-code');
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        event: 'warning',
        args: expect.objectContaining({
          code: 'compaction-model-fallback',
          message: expect.stringContaining('retrying with the current model'),
        }),
      }),
    );
  });

  it('uses the current model when the flag is off (no behavior change)', async () => {
    const { ctx, records } = makeAgent({
      initialConfig: { compactionModel: { model: 'kimi/compaction' } },
    });
    seedHistory(ctx);

    await runManualCompaction(ctx, records);

    const finished = compactionFinished(records);
    expect(finished).toBeDefined();
    expect(finished?.properties?.['model']).toBe('kimi-code');
  });

  it('uses the current model when the flag is on but [compaction_model] is unset', async () => {
    vi.stubEnv(COMPACTION_MODEL_FLAG_ENV, 'true');
    const { ctx, records } = makeAgent();
    seedHistory(ctx);

    await runManualCompaction(ctx, records);

    const finished = compactionFinished(records);
    expect(finished).toBeDefined();
    expect(finished?.properties?.['model']).toBe('kimi-code');
  });
});
