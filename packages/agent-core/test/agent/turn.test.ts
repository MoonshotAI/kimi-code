/**
 * Agent turn integration contracts through the public RPC harness. Provider
 * generation and host-executed user tools are the only external boundaries.
 * Run with: pnpm --filter @moonshot-ai/agent-core test -- turn.test.ts
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable, type Writable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { createControlledPromise } from '@antfu/utils';
import {
  APIConnectionError,
  APIEmptyResponseError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  type ChatProvider,
  type Message,
  type ModelCapability,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { describe, expect, it, afterEach, vi } from 'vitest';

import { HookEngine } from '../../src/session/hooks';
import { abortError } from '../../src/utils/abort';
import type { AgentOptions, AgentRecord, AgentRecordPersistence } from '../../src/agent';
import { ProcessBackgroundTask } from '../../src/agent/background';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import {
  resolveMaxRetriesPerStep,
  resolveMaxStepsPerTurn,
} from '../../src/agent/turn';
import { ErrorCodes, KimiError } from '../../src/errors';
import type { Logger, LogPayload } from '../../src/logging';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from '../../src/session/subagent-host';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import {
  createCommandKaos,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
} from './harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';
import { agentTask } from './background/helpers';

type GenerateFn = NonNullable<AgentOptions['generate']>;

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    createChild: () => logger,
  };
  return { logger, entries };
}

describe('Agent turn flow', () => {
  it('degrades older history media and retries when the provider rejects the request body as too large', async () => {
    let attempts = 0;
    const histories: Message[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      histories.push(structuredClone(history));
      if (attempts === 1) {
        throw new APIRequestTooLargeError(413, 'Request exceeds the maximum size');
      }
      return {
        id: 'mock-degraded-recovery',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 256_000,
      },
    });
    // Three ReadMediaFile-shaped image results in the history.
    for (const name of ['a', 'b', 'c']) {
      ctx.agent.context.appendUserMessage(
        [
          { type: 'text', text: `<image path="/workspace/${name}.png">` },
          { type: 'image_url', imageUrl: { url: `data:image/png;base64,${name}AAA` } },
          { type: 'text', text: '</image>' },
        ],
        { kind: 'user' },
      );
    }

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'inspect the screenshots' }] });
    await ctx.untilTurnEnd();

    expect(attempts).toBe(2);
    // The first request carried all three images.
    const firstParts = histories[0]!.flatMap((message) => message.content);
    expect(firstParts.filter((part) => part.type === 'image_url')).toHaveLength(3);
    // The retry keeps only the two most recent images; the oldest becomes a
    // placeholder while its path wrapper survives for readback.
    const retryParts = histories[1]!.flatMap((message) => message.content);
    const retryImages = retryParts.filter((part) => part.type === 'image_url');
    expect(retryImages).toHaveLength(2);
    expect(
      retryImages.map((part) => (part.type === 'image_url' ? part.imageUrl.url : '')),
    ).toEqual(['data:image/png;base64,bAAA', 'data:image/png;base64,cAAA']);
    const retryText = retryParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(retryText).toContain('[image omitted:');
    expect(retryText).toContain('<image path="/workspace/a.png">');
    // The real history is untouched.
    expect(
      ctx.agent.context.history
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url'),
    ).toHaveLength(3);
  });

  it('gates unsupported image formats at the prompt and steer entry so the session cannot be poisoned', async () => {
    const histories: Message[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      histories.push(structuredClone(history));
      return {
        id: 'mock-format-gate',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 256_000,
      },
    });

    // The SDK/RPC prompt path carries no upstream gate: the turn entry is
    // the last funnel before parts land in the session history.
    await ctx.rpc.prompt({
      input: [
        { type: 'text', text: 'what is in these images?' },
        { type: 'image_url', imageUrl: { url: 'data:image/avif;base64,QUJD' } },
        { type: 'image_url', imageUrl: { url: 'data:image/jpg;base64,REVG' } },
      ],
    });
    await ctx.untilTurnEnd();

    // The AVIF image never reaches the model: a notice stands in, and the
    // accepted image/jpg alias is forwarded as canonical image/jpeg.
    const sentParts = histories[0]!.flatMap((message) => message.content);
    const sentImages = sentParts.filter((part) => part.type === 'image_url');
    expect(sentImages).toEqual([
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,REVG' } },
    ]);
    const sentText = sentParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(sentText).toContain('image/avif');

    // The history itself is clean — no image/avif part can re-poison later turns.
    const historyParts = ctx.agent.context.history.flatMap((message) => message.content);
    expect(
      historyParts.some(
        (part) => part.type === 'image_url' && part.imageUrl.url.includes('image/avif'),
      ),
    ).toBe(false);

    // Steer input enters the history the same way and gets the same gate.
    await ctx.rpc.steer({
      input: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,QUJD' } }],
    });
    await ctx.untilTurnEnd();

    // The steer turn's history also carries the first turn's (canonical)
    // image; what must be gone is the HEIC one.
    const steerParts = histories[1]!.flatMap((message) => message.content);
    expect(
      steerParts.some(
        (part) => part.type === 'image_url' && part.imageUrl.url.includes('image/heic'),
      ),
    ).toBe(false);
    expect(
      steerParts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    ).toContain('image/heic');

    // A mislabeled image is gated on its real bytes: AVIF bytes labeled
    // image/png never reach the model.
    const avif = Buffer.alloc(16);
    avif.writeUInt32BE(16, 0);
    avif.write('ftyp', 4, 'latin1');
    avif.write('avif', 8, 'latin1');
    await ctx.rpc.prompt({
      input: [
        {
          type: 'image_url',
          imageUrl: { url: `data:image/png;base64,${avif.toString('base64')}` },
        },
      ],
    });
    await ctx.untilTurnEnd();

    // The third turn's history also carries the first turn's canonical
    // image; what must be gone is the mislabeled AVIF payload.
    const mislabeledParts = histories[2]!.flatMap((message) => message.content);
    expect(
      mislabeledParts.some(
        (part) =>
          part.type === 'image_url' && part.imageUrl.url.includes(avif.toString('base64')),
      ),
    ).toBe(false);
    expect(
      mislabeledParts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    ).toContain('image/avif');
  });

  describe('media recovery', () => {
    const IMAGE_CAPABLE: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 256_000,
    };

    // Simulate a legacy/pre-gate history that already carries a poisoned
    // image. The turn.prompt gate only sanitizes NEW prompt input, not the
    // pre-existing context, so this reaches the provider unmodified.
    function plantPoisonedImage(ctx: TestAgentContext): void {
      ctx.agent.context.appendUserMessage(
        [
          { type: 'text', text: '<image path="/workspace/old.avif">' },
          { type: 'image_url', imageUrl: { url: 'data:image/avif;base64,QUJD' } },
          { type: 'text', text: '</image>' },
        ],
        { kind: 'user' },
      );
    }

    function okResponse() {
      return {
        id: 'mock-recovery',
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'ok' }],
          toolCalls: [],
        },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed' as const,
        rawFinishReason: 'stop',
      };
    }

    const OVERSIZED_IMAGE = {
      id: 'oversized-image',
      url: 'data:image/png;base64,T1ZFUlNJWkVE',
    } as const;

    async function runStickyStripRecovery(recoveryImage: {
      readonly id?: string;
      readonly url: string;
    }): Promise<Message[][]> {
      let attempts = 0;
      const histories: Message[][] = [];
      const recoveryCall: ToolCall = {
        type: 'function',
        id: 'call-inspect-recovery',
        name: 'InspectRecovery',
        arguments: '{}',
      };
      const generate: GenerateFn = async (_provider, _system, _tools, history) => {
        attempts += 1;
        histories.push(structuredClone(history));
        if (attempts <= 2) {
          throw new APIRequestTooLargeError(413, 'Request exceeds the maximum size');
        }
        if (attempts === 3) {
          return {
            id: 'mock-media-recovery-tool-call',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'inspect the smaller copy' }],
              toolCalls: [recoveryCall],
            },
            usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
            finishReason: 'tool_calls',
            rawFinishReason: 'tool_calls',
          };
        }
        return okResponse();
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'InspectRecovery',
        description: 'Return a model-visible recovery image.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      });
      ctx.agent.context.appendUserMessage(
        [
          { type: 'text', text: '<image path="/workspace/oversized.png">' },
          { type: 'image_url', imageUrl: OVERSIZED_IMAGE },
          { type: 'text', text: '</image>' },
        ],
        { kind: 'user' },
      );

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'recover the image read' }] });
      await ctx.untilToolCall({
        output: [{ type: 'image_url', imageUrl: recoveryImage }],
      });
      await ctx.untilTurnEnd();

      return histories;
    }

    it('strips all media and retries once on a server image-format 400', async () => {
      let attempts = 0;
      const histories: Message[][] = [];
      const generate: GenerateFn = async (_p, _s, _t, history) => {
        attempts += 1;
        histories.push(structuredClone(history));
        if (attempts === 1) throw new APIStatusError(400, 'unsupported image format');
        return okResponse();
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      plantPoisonedImage(ctx);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.untilTurnEnd();

      expect(attempts).toBe(2);
      expect(histories[0]!.flatMap((m) => m.content).some((p) => p.type === 'image_url')).toBe(true);
      expect(histories[1]!.flatMap((m) => m.content).some((p) => p.type === 'image_url')).toBe(false);
      // Read-side only: the real history keeps the poisoned image.
      expect(
        ctx.agent.context.history.flatMap((m) => m.content).some((p) => p.type === 'image_url'),
      ).toBe(true);
    });

    it('strips all media and retries once on kosong client-side image error', async () => {
      let attempts = 0;
      const generate: GenerateFn = async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ChatProviderError('Unsupported media type for base64 image: image/avif');
        }
        return okResponse();
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      plantPoisonedImage(ctx);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.untilTurnEnd();

      // isRetryableGenerateError excludes image-format errors, so no transient
      // retries burn first — exactly one throw then one recovered resend.
      expect(attempts).toBe(2);
    });

    it('does NOT recover a non-image 400 (no wasted resend)', async () => {
      let attempts = 0;
      const generate: GenerateFn = async () => {
        attempts += 1;
        throw new APIStatusError(400, 'max_tokens must be positive');
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      plantPoisonedImage(ctx);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.untilTurnEnd();

      expect(attempts).toBe(1);
    });

    it('does NOT recover image count/size/support errors (no silent blind resend)', async () => {
      // "too many images" mentions "image" but is not a format/data error:
      // stripping media would let the turn complete with the model blind to
      // the user's images, hiding the real problem. Surface it instead.
      let attempts = 0;
      const generate: GenerateFn = async () => {
        attempts += 1;
        throw new APIStatusError(400, 'too many images in request');
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      plantPoisonedImage(ctx);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.untilTurnEnd();

      expect(attempts).toBe(1);
    });

    it('surfaces the error when the strip resend also fails (no infinite loop)', async () => {
      let attempts = 0;
      const generate: GenerateFn = async () => {
        attempts += 1;
        throw new APIStatusError(400, 'unsupported image format');
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' },
        modelCapabilities: IMAGE_CAPABLE,
      });
      plantPoisonedImage(ctx);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.untilTurnEnd();

      expect(attempts).toBe(2);
    });

    it('keeps different media produced after the strip snapshot visible on the next model step', async () => {
      const recoveryImage = {
        id: 'smaller-copy',
        url: 'data:image/png;base64,U01BTExFUl9DT1BZ',
      } as const;

      const histories = await runStickyStripRecovery(recoveryImage);

      expect(histories).toHaveLength(4);
      const finalParts = histories[3]!.flatMap((message) => message.content);
      expect(
        finalParts
          .filter((part) => part.type === 'image_url')
          .map((part) => (part.type === 'image_url' ? part.imageUrl : undefined)),
      ).toEqual([recoveryImage]);
      expect(
        finalParts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
      ).toContain('[image omitted for provider compatibility;');
    });

    it('keeps the same media stripped when a later tool result recreates its container', async () => {
      const histories = await runStickyStripRecovery({ ...OVERSIZED_IMAGE });

      expect(histories).toHaveLength(4);
      const finalParts = histories[3]!.flatMap((message) => message.content);
      expect(finalParts.filter((part) => part.type === 'image_url')).toHaveLength(0);
      expect(
        finalParts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .filter((text) => text.includes('[image omitted for provider compatibility;')),
      ).toHaveLength(2);
    });
  });

  it('tracks turn_started and turn_interrupted telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'turn_started',
      properties: { turn_id: 0, mode: 'agent', thinking_effort: 'off' },
    });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { turn_id: 0, mode: 'agent', thinking_effort: 'off', at_step: 0, interrupt_reason: 'error' },
    });
  });

  it('reports turn_interrupted telemetry as user_cancelled on manual abort', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('should-not-run'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await ctx.untilApprovalRequest();

    // User presses stop: the RPC cancel carries no explicit reason, which the
    // turn treats as a deliberate user cancellation.
    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();

    const interrupted = records.find((candidate) => candidate.event === 'turn_interrupted');
    expect(interrupted).toEqual({
      event: 'turn_interrupted',
      properties: expect.objectContaining({
        mode: 'agent',
        interrupt_reason: 'user_cancelled',
      }),
    });
  });

  it('reports turn_interrupted telemetry as aborted on programmatic abort', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('should-not-run'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await ctx.untilApprovalRequest();

    // A programmatic abort (e.g. a subagent deadline timeout) carries a plain
    // AbortError as its reason, not a UserCancellationError, so telemetry must
    // not report it as a user cancellation.
    ctx.agent.turn.cancel(0, abortError());
    await ctx.untilTurnEnd();

    const interrupted = records.find((candidate) => candidate.event === 'turn_interrupted');
    expect(interrupted).toEqual({
      event: 'turn_interrupted',
      properties: expect.objectContaining({ mode: 'agent', interrupt_reason: 'aborted' }),
    });
  });

  it('holds the turn until a background subagent finishes, then runs a wrap-up step', async () => {
    const ctx = testAgent();
    ctx.agent.printDrainAgentTasksOnStop = true;

    const subDone = createControlledPromise<{ result: string }>();
    ctx.agent.background.registerTask(agentTask(subDone, 'subagent'));

    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    ctx.mockNextResponse({ type: 'text', text: 'wrap-up' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });

    let turnEnded = false;
    const turnEnd = ctx.untilTurnEnd().then(() => {
      turnEnded = true;
    });

    // Let the first model step finish and the drain hold engage.
    for (let i = 0; i < 100 && ctx.llmCalls.length < 1; i++) await delay(5);
    await delay(20);
    expect(turnEnded).toBe(false);

    // Completing the subagent releases the hold; the model takes a wrap-up step.
    subDone.resolve({ result: 'sub-result' });
    await turnEnd;

    expect(turnEnded).toBe(true);
    expect(ctx.llmCalls.length).toBe(2);
  });

  it('does not hold the turn for a non-agent (process) background task', async () => {
    const ctx = testAgent();
    ctx.agent.printDrainAgentTasksOnStop = true;

    const proc: KaosProcess = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 4242,
      exitCode: null,
      wait: vi.fn().mockReturnValue(new Promise<number>(() => {})) as unknown as KaosProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as unknown as KaosProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as unknown as KaosProcess['dispose'],
    };
    ctx.agent.background.registerTask(new ProcessBackgroundTask(proc, 'sleep 60', 'proc'));

    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'only step' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    // Process tasks do not trigger the subagent-only drain hold, so the turn
    // ends after the single step.
    expect(ctx.llmCalls.length).toBe(1);
  });

  it('tracks turn_ended telemetry with protocol props', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const started = records.find((candidate) => candidate.event === 'turn_started');
    expect(started).toEqual({
      event: 'turn_started',
      properties: expect.objectContaining({ mode: 'agent', provider_type: 'kimi', protocol: 'kimi', thinking_effort: 'off' }),
    });

    const ended = records.find((candidate) => candidate.event === 'turn_ended');
    expect(ended).toEqual({
      event: 'turn_ended',
      properties: expect.objectContaining({
        turn_id: 0,
        mode: 'agent',
        reason: 'completed',
        provider_type: 'kimi',
        protocol: 'kimi',
        thinking_effort: 'off',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('attaches the provider trace id to turn and tool telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('traced'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'running' }, bashCallWithId('call_traced', 'printf traced')],
      traceId: 'trace-turn-1',
    });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      traceId: 'trace-turn-2',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run' }] });
    await ctx.untilTurnEnd();

    // tool_call attributes to the request that produced the call.
    const toolCall = records.find((candidate) => candidate.event === 'tool_call');
    expect(toolCall?.properties?.['trace_id']).toBe('trace-turn-1');
    // turn_ended attributes to the turn's most recent request.
    const ended = records.find((candidate) => candidate.event === 'turn_ended');
    expect(ended?.properties?.['trace_id']).toBe('trace-turn-2');
  });

  it('omits trace_id from turn telemetry when the provider reports none', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const ended = records.find((candidate) => candidate.event === 'turn_ended');
    expect(ended?.properties?.['trace_id']).toBeUndefined();
  });

  it('tracks duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('dup'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedup_detected',
      properties: {
        turn_id: 0,
        step_no: 1,
        tool_name: 'Bash',
        dup_type: 'same_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: expect.objectContaining({
        policy_name: 'yolo-mode-approve',
        tool_name: 'Bash',
        permission_mode: 'yolo',
        decision: 'approve',
      }),
    });
  });

  it('tracks cross-step duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('dup'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(bashCallWithId('call_dup_1', 'printf dup'));
    ctx.mockNextResponse(bashCallWithId('call_dup_2', 'printf dup'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates across steps' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedup_detected',
      properties: {
        turn_id: 0,
        step_no: 2,
        tool_name: 'Bash',
        dup_type: 'cross_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_name: 'Bash',
        outcome: 'success',
        dup_type: 'cross_step',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('fires PostToolUse for same-step dups with the original real output, not the dedup placeholder', async () => {
    // Hook command asserts the dup's PostToolUse payload carries the real
    // stdout ('dup'), not the placeholder ('').
    const assertScript = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  const payload = JSON.parse(input);',
      "  if (typeof payload.tool_output === 'string' && payload.tool_output.includes('dup')) process.exit(0);",
      "  console.error('bad tool_output: ' + JSON.stringify(payload.tool_output));",
      '  process.exit(2);',
      '});',
    ].join('');
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: `node -e ${JSON.stringify(assertScript)}`,
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({ kaos: createCommandKaos('dup'), hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([
        ['PostToolUse', 'Bash', 'allow'],
        ['PostToolUse', 'Bash', 'allow'],
      ]);
    });
  });

  it('tracks failed tool-call telemetry with error taxonomy', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();
    records.length = 0;

    ctx.mockNextResponse({
      type: 'function',
      id: 'call_missing',
      name: 'MissingTool',
      arguments: '{}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Call a missing tool' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_name: 'MissingTool',
        outcome: 'error',
        dup_type: 'normal',
        error_type: 'ToolNotFound',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('emits a failed turn and error when generation fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Trigger generate failure" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Trigger generate failure" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "error", "message": "Unexpected generate call #1" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false, "details": { "turnId": 0 } } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false, "details": { "turnId": 0 } }`,
    );
    await ctx.expectResumeMatches();
  });

  it('keeps manual swarm mode active after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'manual' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(true);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBe(-1);
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    const turnEndedIndex = eventIndex(ctx, '[rpc]', 'turn.ended');
    const swarmExitIndex = eventIndex(ctx, '[wire]', 'swarm_mode.exit');
    const inactiveStatusIndex = ctx.allEvents.findIndex((entry, index) => {
      return (
        index > turnEndedIndex &&
        entry.type === '[rpc]' &&
        entry.event === 'agent.status.updated' &&
        (entry.args as { readonly swarmMode?: boolean }).swarmMode === false
      );
    });

    expect(ctx.agent.swarmMode.isActive).toBe(false);
    expect(swarmExitIndex).toBeGreaterThan(turnEndedIndex);
    expect(inactiveStatusIndex).toBeGreaterThan(turnEndedIndex);
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode when the swarm turn fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fail a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('exits task swarm mode when the user cancels the swarm turn', async () => {
    const ctx = testAgent({ generate: abortableGenerate });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Cancel a swarm task' }] });
    await stepStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();

    expect(ctx.agent.swarmMode.isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('enters silent swarm mode when the agent calls AgentSwarm', async () => {
    const runQueued = vi.fn(async <T>(
      tasks: readonly QueuedSubagentTask<T>[],
    ): Promise<Array<QueuedSubagentRunResult<T>>> => {
      return tasks.map((task, index) => ({
        task,
        agentId: `agent-${String(index + 1)}`,
        status: 'completed' as const,
        result: `result ${String(index + 1)}`,
      }));
    });
    const subagentHost = mockSubagentHost({
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const ctx = testAgent({
      subagentHost,
    });
    ctx.configure({ tools: ['AgentSwarm'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      { type: 'text', text: 'I will launch a swarm.' },
      agentSwarmCall(),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Swarm results reviewed.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use AgentSwarm' }] });
    await ctx.untilTurnEnd();

    const enterEvent = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'swarm_mode.enter',
    );
    const reminderOrigins = ctx.agent.context.history
      .map((message) => message.origin)
      .filter((origin) => origin?.kind === 'injection');

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(enterEvent?.args).toMatchObject({ trigger: 'tool' });
    expect(ctx.agent.swarmMode.isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(
      eventIndex(ctx, '[rpc]', 'turn.ended'),
    );
    expect(reminderOrigins).not.toContainEqual({ kind: 'injection', variant: 'swarm_mode' });
    expect(reminderOrigins).not.toContainEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('includes provider finish reason details on empty response failures', async () => {
    const generate: GenerateFn = async () => {
      throw new APIEmptyResponseError(
        'The API returned a response containing only thinking content without any text or tool calls. ' +
          'Provider stop details: finishReason=filtered, rawFinishReason=content_filter.',
        {
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
      );
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.filtered',
            name: 'APIEmptyResponseError',
            details: expect.objectContaining({
              finishReason: 'filtered',
              rawFinishReason: 'content_filter',
              turnId: 0,
            }),
          }),
        }),
      }),
    );
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'error',
        args: expect.objectContaining({
          code: 'provider.filtered',
          name: 'APIEmptyResponseError',
          details: expect.objectContaining({
            finishReason: 'filtered',
            rawFinishReason: 'content_filter',
            turnId: 0,
          }),
        }),
      }),
    );
  });

  it('ends the turn with a provider.filtered error when the provider filters a non-empty response', async () => {
    const generate: GenerateFn = async () => ({
      id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'some filtered text' }],
        toolCalls: [],
      },
      usage: {
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.filtered',
            details: expect.objectContaining({
              finishReason: 'filtered',
              turnId: 0,
            }),
          }),
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('emits a friendly model.not_configured error when no model is configured', async () => {
    const ctx = testAgent();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] metadata                 { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] turn.prompt              { "input": [ { "type": "text", "text": "Hello without login" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello without login" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] turn.ended               { "turnId": 0, "reason": "failed", "error": { "code": "model.not_configured", "message": "LLM not set, send \\"/login\\" to login", "name": "KimiError", "details": { "turnId": 0 }, "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "model.not_configured", "message": "LLM not set, send \\"/login\\" to login", "name": "KimiError", "details": { "turnId": 0 }, "retryable": false }`,
    );
  });

  it('continues the turn after projecting UserPromptSubmit hook output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command:
          'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);if(Array.isArray(o.prompt)&&o.prompt[0]?.text===\\"hooked input\\"){process.stdout.write(\\"hook response 1\\");process.exit(0);}console.error(\\"bad prompt\\");process.exit(1);})"',
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'node -e "process.stdout.write(\'hook response 2\')"',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 1\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 2\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'hook response 1\n\nhook response 2',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: 'model saw original prompt only' }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects structured UserPromptSubmit stdout', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'node -e "process.stdout.write(\'{}\')"',
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'node -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{}}))"',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\n{}\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\n{\\"hookSpecificOutput\\":{}}\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: '{}\n\n{"hookSpecificOutput":{}}',
        }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\n{"hookSpecificOutput":{}}\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('stops the turn when a UserPromptSubmit hook blocks', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'bad words',
        command: 'node -e "process.stderr.write(\'no profanity\'); process.exit(2)"',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'bad words here' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult = '<hook_result hook_event="UserPromptSubmit">\nno profanity\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'no profanity',
          blocked: true,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'blocked' }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'bad words here' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'safe answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'safe followup' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "bad words here"
        assistant: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nno profanity\\n</hook_result>"
        user: text "safe followup"
    `);
  });

  it('cancels while waiting for a UserPromptSubmit hook without appending stale output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        command: 'node -e "setTimeout(() => process.stdout.write(\\"late hook\\"), 250)"',
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hook will sleep' }] });
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: expect.stringContaining('late hook') }),
      }),
    );
    expect(ctx.agent.context.data().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hook will sleep' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    ]);
  });

  it('uses a Stop hook block reason as a one-shot turn continuation', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: 'node -e "process.stderr.write(\'continue from hook\'); process.exit(2)"',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const stopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: 'stop_hook' },
    };
    const llmStopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
    };
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('continue from hook');
    expect(ctx.agent.context.data().history).toContainEqual(stopHookMessage);
    expect(ctx.llmCalls[1]?.history).toContainEqual(llmStopHookMessage);
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('Second answer.');
  });

  it('cancels while waiting for a Stop hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-stop-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stderr.write('late stop hook'), 250);",
    ].join('');
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Answer before stop hook.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.agent.context.data().history)).not.toContain('late stop hook');
  });

  it('cancels while waiting for a PreToolUse hook inside permission evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pre-tool-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stdout.write('late pre tool hook'), 250);",
    ].join('');
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      hookEngine,
    });
    const beforeToolCall = vi.spyOn(ctx.agent.permission, 'beforeToolCall');
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    ctx.newEvents();
    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash while hook sleeps' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(JSON.stringify(ctx.agent.context.data().history)).not.toContain('late pre tool hook');
  });

  it('fires StopFailure when a turn fails', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'StopFailure',
          matcher: 'Error',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['StopFailure', 'Error', 1]]);
  });

  it('fires Interrupt when the user cancels an active turn', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({
      hookEngine,
      kaos: createCommandKaos('should-not-run'),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await ctx.untilApprovalRequest();

    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['Interrupt', '', 1]]);
  });

  it('does not fire Interrupt for a non-user (programmatic) abort', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({
      hookEngine,
      kaos: createCommandKaos('should-not-run'),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await ctx.untilApprovalRequest();

    // A programmatic abort (e.g. a subagent deadline timeout) carries a plain
    // AbortError as its reason, not a UserCancellationError, so it must not be
    // reported as a user interrupt.
    ctx.agent.turn.cancel(0, abortError());
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([]);
  });

  it('resolves the latest request-scoped OAuth auth before each generation', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const tokens = ['first-turn-token', 'second-turn-token'];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected token request');
      return token;
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const firstEvents = await ctx.untilTurnEnd();
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello again' }] });
    const secondEvents = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['first-turn-token', 'second-turn-token']);
    expect(tokenCalls).toEqual([undefined, undefined]);
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with first-turn-token' },
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 1, delta: 'Generated with second-turn-token' },
      }),
    );
    expect(firstEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
    expect(secondEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
  });

  it('emits LLM stream timing on step completion', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'timed answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      llmFirstTokenLatencyMs: expect.any(Number),
      llmStreamDurationMs: expect.any(Number),
    });
  });

  it('logs LLM request metadata without message bodies', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'secret prompt body should stay out of logs' }],
    });
    await ctx.untilTurnEnd();

    const configLogs = entries.filter((entry) => entry.message === 'llm config');
    expect(configLogs).toHaveLength(1);
    const configPayload = configLogs[0]?.payload as Record<string, unknown>;
    expect(configPayload).toMatchObject({
      turnStep: '0.1',
      provider: 'kimi',
      model: 'mock-model',
      modelAlias: 'mock-model',
      toolCount: 0,
    });
    expect(configPayload['systemPromptChars']).toEqual(expect.any(Number));

    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    expect(requestLogs).toHaveLength(1);
    const payload = requestLogs[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      turnStep: '0.1',
    });
    expect(payload).not.toHaveProperty('estimatedInputTokens');
    expect(payload).not.toHaveProperty('turnId');
    expect(payload).not.toHaveProperty('step');
    expect(payload).not.toHaveProperty('attempt');
    expect(payload).not.toHaveProperty('maxAttempts');
    expect(payload).not.toHaveProperty('stepUuid');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('modelAlias');
    expect(payload).not.toHaveProperty('thinkingEffort');
    expect(payload).not.toHaveProperty('systemPromptChars');
    expect(payload).not.toHaveProperty('partialMessageCount');
    expect(payload).not.toHaveProperty('messageCount');
    expect(payload).not.toHaveProperty('toolCallCount');
    expect(payload).not.toHaveProperty('toolCount');
    expect(payload).not.toHaveProperty('systemPromptHash');
    expect(payload).not.toHaveProperty('toolsHash');
    expect(payload).not.toHaveProperty('messageRoles');
    expect(payload).not.toHaveProperty('contentPartTypes');
    expect(payload).not.toHaveProperty('toolNames');
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(entries)).not.toContain('secret prompt body should stay out of logs');
  });

  it('does not repeat unchanged LLM config metadata', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    expect(entries.filter((entry) => entry.message === 'llm config')).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === 'llm request')).toHaveLength(2);
  });

  it('logs changed LLM config when same-size system prompt content changes', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();

    ctx.agent.config.update({ systemPrompt: 'alpha' });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.agent.config.update({ systemPrompt: 'bravo' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    const configPayloads = entries
      .filter((entry) => entry.message === 'llm config')
      .map((entry) => entry.payload as Record<string, unknown>);
    expect(configPayloads).toHaveLength(2);
    expect(configPayloads.map((payload) => payload['systemPromptChars'])).toEqual([5, 5]);
    for (const payload of configPayloads) {
      expect(payload).not.toHaveProperty('systemPromptHash');
      expect(payload).not.toHaveProperty('toolsHash');
    }
  });

  it('does not log estimated LLM request tokens when tools are present', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent({ log: logger });
    ctx.configure();
    await ctx.rpc.setActiveTools({ names: ['Bash'] });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use bash' }] });
    await ctx.untilTurnEnd();

    const input = ctx.llmCalls[0];
    expect(input?.tools.length).toBeGreaterThan(0);
    const requestPayload = entries.find((entry) => entry.message === 'llm request')?.payload as
      | Record<string, unknown>
      | undefined;
    expect(requestPayload).not.toHaveProperty('estimatedInputTokens');
  });

  it('classifies OAuth resolver connection failures as provider connection errors without retrying', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(
        ErrorCodes.PROVIDER_CONNECTION_ERROR,
        'OAuth provider "managed:kimi-code" failed to fetch an access token: fetch failed',
      );
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
            message: expect.stringContaining('fetch failed'),
            retryable: true,
          }),
        }),
      }),
    );
  });

  it('classifies explicit OAuth login-required resolver failures as auth errors', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in');
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.AUTH_LOGIN_REQUIRED,
            retryable: false,
          }),
        }),
      }),
    );
  });

  it('honors configured maxStepsPerTurn in agent turns', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
      kaos: createCommandKaos('loop-output'),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.newEvents();

    const bashCall: ToolCall = {
      id: 'call_bash',
      type: 'function',
      name: 'Bash',
      arguments: '{"command":"printf loop-output","timeout":60}',
    };
    ctx.mockNextResponse(bashCall);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command once' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'loop.max_steps_exceeded',
            message: expect.stringContaining('config.toml'),
            details: expect.objectContaining({
              maxSteps: 1,
            }),
          }),
        }),
      }),
    );
  });

  describe('loop control env overrides', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('honors KIMI_LOOP_MAX_STEPS_PER_TURN over config in agent turns', async () => {
      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '1');
      const ctx = testAgent({
        initialConfig: {
          providers: {},
          loopControl: { maxStepsPerTurn: 100 },
        },
        kaos: createCommandKaos('loop-output'),
      });
      ctx.configure({ tools: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
      ctx.newEvents();

      const bashCall: ToolCall = {
        id: 'call_bash',
        type: 'function',
        name: 'Bash',
        arguments: '{"command":"printf loop-output","timeout":60}',
      };
      ctx.mockNextResponse(bashCall);

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command once' }] });
      const events = await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'turn.ended',
          args: expect.objectContaining({
            reason: 'failed',
            error: expect.objectContaining({
              code: 'loop.max_steps_exceeded',
              details: expect.objectContaining({
                maxSteps: 1,
              }),
            }),
          }),
        }),
      );
    });

    it('prefers KIMI_LOOP_MAX_STEPS_PER_TURN over config and ignores invalid values', () => {
      expect(resolveMaxStepsPerTurn(100)).toBe(100);
      expect(resolveMaxStepsPerTurn()).toBeUndefined();

      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '5');
      expect(resolveMaxStepsPerTurn(100)).toBe(5);
      expect(resolveMaxStepsPerTurn()).toBe(5);

      // `0` is a valid override: it means "no cap", same as the config field.
      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '0');
      expect(resolveMaxStepsPerTurn(100)).toBe(0);

      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', 'abc');
      expect(resolveMaxStepsPerTurn(100)).toBe(100);
      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '-3');
      expect(resolveMaxStepsPerTurn(100)).toBe(100);
      vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '1.5');
      expect(resolveMaxStepsPerTurn()).toBeUndefined();
    });

    it('prefers KIMI_LOOP_MAX_RETRIES_PER_STEP over config and ignores invalid values', () => {
      expect(resolveMaxRetriesPerStep(10)).toBe(10);
      expect(resolveMaxRetriesPerStep()).toBeUndefined();

      vi.stubEnv('KIMI_LOOP_MAX_RETRIES_PER_STEP', '3');
      expect(resolveMaxRetriesPerStep(10)).toBe(3);
      expect(resolveMaxRetriesPerStep()).toBe(3);

      vi.stubEnv('KIMI_LOOP_MAX_RETRIES_PER_STEP', '0');
      expect(resolveMaxRetriesPerStep(10)).toBe(0);

      vi.stubEnv('KIMI_LOOP_MAX_RETRIES_PER_STEP', 'not-a-number');
      expect(resolveMaxRetriesPerStep(10)).toBe(10);
      vi.stubEnv('KIMI_LOOP_MAX_RETRIES_PER_STEP', '-1');
      expect(resolveMaxRetriesPerStep(10)).toBe(10);
    });
  });

  it('force-refreshes OAuth credentials and replays the request on 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      if (authKeys.length === 1) throw new APIStatusError(401, 'Unauthorized', 'req-401');
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent({ ...oauthOptions, generate });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with forced-refresh-token' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('treats 401 after force-refresh as provider auth error', async () => {
    const records: TelemetryRecord[] = [];
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      throw new APIStatusError(
        401,
        'Unauthorized',
        'req-401',
        null,
        authKeys.length === 1 ? 'trace-initial-401' : 'trace-replay-401',
      );
    };
    const ctx = testAgent({ ...oauthOptions, generate, telemetry: recordingTelemetry(records) });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.auth_error',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-401',
            }),
          }),
        }),
      }),
    );
    expect(records.find((record) => record.event === 'api_error')?.properties?.['trace_id']).toBe(
      'trace-replay-401',
    );
    expect(records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id']).toBe(
      'trace-replay-401',
    );
  });

  it('keeps non-OAuth provider 401 as provider auth error', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-api-key-401');
    };
    const ctx = testAgent({ generate });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.auth_error',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-api-key-401',
            }),
          }),
        }),
      }),
    );
  });

  it.each<ApiErrorTelemetryCase>([
    {
      name: '429 status',
      createError: () => new APIStatusError(429, 'Rate limited', 'req-429'),
      errorType: 'rate_limit',
      statusCode: 429,
    },
    {
      name: '401 status',
      createError: () => new APIStatusError(401, 'Unauthorized', 'req-401'),
      errorType: 'auth',
      statusCode: 401,
    },
    {
      name: '403 status',
      createError: () => new APIStatusError(403, 'Forbidden', 'req-403'),
      errorType: 'auth',
      statusCode: 403,
    },
    {
      name: '500 status',
      createError: () => new APIStatusError(500, 'Internal server error', 'req-500'),
      errorType: '5xx_server',
      statusCode: 500,
    },
    {
      name: '400 status',
      createError: () => new APIStatusError(400, 'Bad request', 'req-400'),
      errorType: '4xx_client',
      statusCode: 400,
    },
    {
      name: 'context overflow status',
      createError: () => new APIStatusError(422, 'Maximum context window exceeded', 'req-422'),
      errorType: 'context_overflow',
      statusCode: 422,
    },
    {
      name: 'context overflow token count status',
      createError: () =>
        new APIStatusError(
          400,
          'input token count 131072 exceeds the maximum number of tokens allowed',
          'req-token-count',
        ),
      errorType: 'context_overflow',
      statusCode: 400,
    },
    {
      name: 'connection error',
      createError: () => new APIConnectionError('socket hang up'),
      errorType: 'network',
    },
    {
      name: 'timeout error',
      createError: () => new APITimeoutError('request timed out'),
      errorType: 'timeout',
    },
    {
      name: 'empty response error',
      createError: () => new APIEmptyResponseError('empty response'),
      errorType: 'empty_response',
    },
    {
      name: 'generic step error',
      createError: () => new Error('unexpected step failure'),
      errorType: 'other',
    },
  ])('tracks api_error telemetry for $name', async ({ createError, errorType, statusCode }) => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw createError();
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const expectedProperties: Record<string, unknown> = {
      error_type: errorType,
      model: 'mock-model',
      alias: 'mock-model',
      provider_type: 'kimi',
      protocol: 'kimi',
      retryable: expect.any(Boolean),
      duration_ms: expect.any(Number),
    };
    if (statusCode !== undefined) {
      expectedProperties['status_code'] = statusCode;
    }

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record).toEqual({
      event: 'api_error',
      properties: expect.objectContaining(expectedProperties),
    });
    if (statusCode === undefined) {
      expect(record?.properties).not.toHaveProperty('status_code');
    }
  });

  it('tracks api_error with the failed request trace id from the error response', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw new APIStatusError(500, 'server exploded', 'req-1', null, 'trace-err-1');
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record?.properties?.['trace_id']).toBe('trace-err-1');
  });

  it('omits trace_id from api_error when the failure carried no response', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record).toBeDefined();
    expect(record?.properties?.['trace_id']).toBeUndefined();
  });

  it('attributes api_error to the in-flight request trace on post-headers failures', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, _history, _callbacks, options) => {
      // Mirror kosong generate(): the trace id callback fires as soon as the
      // response headers arrive, before the stream body is drained — so a
      // mid-stream failure has a captured trace but none on the error itself.
      options?.onTraceId?.('trace-mid-stream');
      throw new APIEmptyResponseError('empty response');
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record?.properties?.['trace_id']).toBe('trace-mid-stream');
  });

  it('omits trace_id from api_error when a later step fails before response headers', async () => {
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, _callbacks, options) => {
      calls += 1;
      if (calls === 1) {
        options?.onTraceId?.('trace-step-1');
        return {
          id: 'mock-step-1',
          message: {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'running' }],
            toolCalls: [
              {
                type: 'function' as const,
                id: 'call_traced',
                name: 'Bash',
                arguments: '{"command":"printf traced"}',
              },
            ],
          },
          usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_calls' as const,
          rawFinishReason: 'tool_calls',
          traceId: 'trace-step-1',
        };
      }
      // Step 2's request fails before any response headers arrive: neither
      // the error nor the in-flight capture has a trace, and step 1's trace
      // must not leak into api_error.
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({
      generate,
      kaos: createCommandKaos('traced'),
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run' }] });
    await ctx.untilTurnEnd();

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record).toBeDefined();
    expect(record?.properties?.['trace_id']).toBeUndefined();
  });

  it('attributes turn-level telemetry to the failed request trace on error turns', async () => {
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, _callbacks, options) => {
      calls += 1;
      if (calls === 1) {
        // Mirror kosong generate(): the trace id callback fires before the
        // stream is drained, as soon as the response headers arrive.
        options?.onTraceId?.('trace-step-1');
        return {
          id: 'mock-step-1',
          message: {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'running' }],
            toolCalls: [
              {
                type: 'function' as const,
                id: 'call_traced',
                name: 'Bash',
                arguments: '{"command":"printf traced"}',
              },
            ],
          },
          usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_calls' as const,
          rawFinishReason: 'tool_calls',
          traceId: 'trace-step-1',
        };
      }
      throw new APIStatusError(429, 'rate limited', 'req-2', null, 'trace-fail-2');
    };
    const ctx = testAgent({
      generate,
      kaos: createCommandKaos('traced'),
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run' }] });
    await ctx.untilTurnEnd();

    // The turn failed on step 2's request: turn-level events attribute to the
    // failed request's trace, not the previous successful step's.
    const ended = records.find((candidate) => candidate.event === 'turn_ended');
    expect(ended?.properties?.['reason']).toBe('failed');
    expect(ended?.properties?.['trace_id']).toBe('trace-fail-2');
    const interrupted = records.find((candidate) => candidate.event === 'turn_interrupted');
    expect(interrupted?.properties?.['trace_id']).toBe('trace-fail-2');
  });

  it('does not reuse the previous step trace when beforeStep fails before a request', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, _history, _callbacks, options) => {
      options?.onTraceId?.('trace-step-1');
      return {
        id: 'mock-step-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'running' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_traced',
              name: 'Bash',
              arguments: '{"command":"printf traced"}',
            },
          ],
        },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'tool_calls',
        rawFinishReason: 'tool_calls',
        traceId: 'trace-step-1',
      };
    };
    const ctx = testAgent({
      generate,
      kaos: createCommandKaos('traced'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    let beforeStepCalls = 0;
    vi.spyOn(ctx.agent.fullCompaction, 'beforeStep').mockImplementation(async () => {
      beforeStepCalls += 1;
      if (beforeStepCalls === 2) throw new Error('before step failed');
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run' }] });
    await ctx.untilTurnEnd();

    expect(records.find((record) => record.event === 'tool_call')?.properties?.['trace_id']).toBe('trace-step-1');
    expect(records.find((record) => record.event === 'turn_interrupted')?.properties?.['trace_id']).toBeUndefined();
    expect(records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id']).toBeUndefined();
  });

  it('attributes turn-level telemetry to the last failed attempt after retries', async () => {
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      throw new APIStatusError(429, 'rate limited', `req-${String(calls)}`, null, `trace-fail-${String(calls)}`);
    };
    const ctx = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 2 },
      },
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    expect(calls).toBe(2);
    const ended = records.find((candidate) => candidate.event === 'turn_ended');
    expect(ended?.properties?.['trace_id']).toBe('trace-fail-2');
    const apiError = records.find((candidate) => candidate.event === 'api_error');
    expect(apiError?.properties?.['trace_id']).toBe('trace-fail-2');
  });

  it('omits the previous attempt trace when the final retry fails before headers', async () => {
    const records: TelemetryRecord[] = [];
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls += 1;
      if (calls === 1) {
        throw new APIStatusError(429, 'rate limited', 'req-1', null, 'trace-fail-1');
      }
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 2 },
      },
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger mixed retry failures' }] });
    await ctx.untilTurnEnd();

    expect(calls).toBe(2);
    expect(records.find((record) => record.event === 'api_error')?.properties?.['trace_id']).toBeUndefined();
    expect(records.find((record) => record.event === 'turn_interrupted')?.properties?.['trace_id']).toBeUndefined();
    expect(records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id']).toBeUndefined();
  });

  it('keeps transient retry handling with request-scoped OAuth auth', async () => {
    const { logger, entries } = captureLogs();
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async () => 'fresh-token');
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length === 1) {
        throw new APIConnectionError('socket hang up');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Recovered after retry' });
      options?.onStreamEnd?.();
      return textResult('Recovered after retry');
    };
    const ctx = testAgent({ ...oauthOptions, generate, log: logger });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'fresh-token']);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.retrying',
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          errorName: 'APIConnectionError',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Recovered after retry' },
      }),
    );
    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    const payloads = requestLogs.map((entry) => entry.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ turnStep: '0.1' });
    expect(payloads[0]).not.toHaveProperty('attempt');
    expect(payloads[1]).toMatchObject({ turnStep: '0.1', attempt: '2/10' });
  });

  it('force-refreshes OAuth credentials on video upload 401 and surfaces the provider auth error when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const provider = {
      uploadVideo: vi.fn().mockImplementation(async (_input, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        throw new APIStatusError(401, 'Unauthorized', 'req-upload-401');
      }),
    } as unknown as ChatProvider;
    const ctx = testAgent({
      ...oauthOptions,
      kaos: createVideoKaos(),
    });
    ctx.agent.config.update({
      cwd: process.cwd(),
      modelAlias: 'kimi-code',
      systemPrompt: 'test system prompt',
      thinkingEffort: 'off',
    });
    Object.defineProperty(ctx.agent.config, 'provider', {
      configurable: true,
      get: () => provider,
    });
    ctx.agent.tools.initializeBuiltinTools();
    ctx.agent.tools.setActiveTools(['ReadMediaFile']);

    const tool = ctx.agent.tools.loopTools.find((candidate) => candidate.name === 'ReadMediaFile');
    if (tool === undefined) throw new Error('ReadMediaFile tool was not initialized');
    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'call_media',
      args: { path: '/workspace/sample.mp4' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(result.output).toContain('Unauthorized');
    expect(result.output).not.toContain('OAuth provider credentials were rejected');
    expect(result.output).not.toContain('Send /login to login');
  });

  it('cancels an active turn', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({
      kaos: createCommandKaos('should-not-run'),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run a command" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will run Bash." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run Bash." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run a command"
    `);
    records.length = 0;
    await ctx.rpc.cancel({ turnId: 0 });
    expect(records).toContainEqual({
      event: 'cancel',
      properties: { from: 'streaming' },
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.cancel                 { "turnId": 0, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "aborted" }
      [emit] turn.ended                  { "turnId": 0, "reason": "cancelled" }
    `);
    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_name: 'Bash',
        outcome: 'cancelled',
        dup_type: 'normal',
        duration_ms: expect.any(Number),
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('buffers steer input and includes it in the same turn after approval', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf approved","timeout":60}',
    };
    const ctx = testAgent({
      kaos: createCommandKaos('approved'),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will ask first.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash, then listen' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash, then listen" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash, then listen" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will ask first." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf approved\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will ask first." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run Bash, then listen"
    `);
    expect(ctx.llmCalls).toHaveLength(1);

    await ctx.rpc.steer({ input: [{ type: 'text', text: 'Also mention the steer.' }] });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[wire] turn.steer   { "input": [ { "type": "text", "text": "Also mention the steer." } ], "origin": { "kind": "user" }, "time": "<time>" }`);

    ctx.mockNextResponse({ type: 'text', text: 'Approved, and I saw the steer.' });
    approval.respond({
      decision: 'approved',
      selectedLabel: 'approve',
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress                       { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "approved" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "approved" } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "approved" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 29, "maxContextTokens": 1000000, "contextUsage": 0.000029, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "Also mention the steer." } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                         { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999971, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "Approved, and I saw the steer." }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "Approved, and I saw the steer." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 50, "maxContextTokens": 1000000, "contextUsage": 0.00005, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will ask first."  calls call_bash:Bash { "command": "printf approved", "timeout": 60 }
        tool[call_bash]: text "approved"
        user: text "Also mention the steer."
    `);
    expect(ctx.llmCalls).toHaveLength(2);
    await ctx.expectResumeMatches();
  });

  it('rejects a non-steer prompt while a turn is active', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('should-not-run') });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will wait for approval.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the active turn' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Start the active turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Start the active turn" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will wait for approval." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will wait for approval." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Start the active turn"
    `);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'This should not start a new turn' }] });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] turn.prompt   { "input": [ { "type": "text", "text": "This should not start a new turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] error         { "code": "turn.agent_busy", "message": "Cannot launch a new turn while another turn (ID 0) is active", "details": { "turnId": 0 }, "retryable": true }
    `);
    await ctx.rpc.cancel({ turnId: 0 });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.cancel                 { "turnId": 0, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "The user manually interrupted \\"Bash\\" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.", "isError": true }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "aborted" }
      [emit] turn.ended                  { "turnId": 0, "reason": "cancelled" }
    `);
    await ctx.expectResumeMatches();
  });
});

const abortableGenerate: GenerateFn = async (
  _chat,
  _systemPrompt,
  _tools,
  _history,
  _callbacks,
  options,
) => {
  await new Promise<void>((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options?.signal?.aborted === true) {
      rejectAbort();
      return;
    }
    options?.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  throw new Error('abortableGenerate unexpectedly completed');
};

function eventIndex(
  ctx: Pick<ReturnType<typeof testAgent>, 'allEvents'>,
  type: string,
  event: string,
): number {
  return ctx.allEvents.findIndex((entry) => entry.type === type && entry.event === event);
}

function bashCall(): ToolCall {
  return bashCallWithId('call_bash', 'printf should-not-run');
}

function bashCallWithId(id: string, command: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

function agentSwarmCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_swarm',
    name: 'AgentSwarm',
    arguments: JSON.stringify({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    }),
  };
}

function mockSubagentHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return { spawn: vi.fn(), resume: vi.fn(), runQueued: vi.fn(), ...host } as unknown as T &
    SessionSubagentHost;
}

interface ApiErrorTelemetryCase {
  readonly name: string;
  readonly createError: () => Error;
  readonly errorType: string;
  readonly statusCode?: number;
}

function singleAttemptAgentOptions(): Pick<TestAgentOptions, 'initialConfig'> {
  return {
    initialConfig: {
      providers: {},
      loopControl: { maxRetriesPerStep: 1 },
    },
  };
}

const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

const DEFAULT_MEDIA_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: MP4_HEADER.length,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

function createVideoKaos(): Kaos {
  return createFakeKaos({
    stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_MEDIA_STAT),
    readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function mediaCapabilities(): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 1_000_000,
  };
}

function oauthAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
  capabilities?: readonly string[] | undefined,
): Pick<TestAgentOptions, 'initialConfig' | 'providerManagerOverrides'> {
  return {
    initialConfig: {
      defaultModel: 'kimi-code',
      providers: {
        'managed:kimi-code': {
          type: 'vertexai',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'kimi-code': {
          provider: 'managed:kimi-code',
          model: 'kimi-for-coding',
          maxContextSize: 1_000_000,
          capabilities: capabilities === undefined ? undefined : [...capabilities],
        },
      },
    },
    providerManagerOverrides: {
      resolveOAuthTokenProvider: vi.fn(() => ({ getAccessToken })),
    },
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-oauth-retry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

describe('abandoned tool exchange teardown', () => {
  it('closes dangling tool calls when a turn dies mid-batch so follow-up messages are not swallowed', async () => {
    // A transcript write failure between a recorded tool.call and its paired
    // tool.result breaks the batch's "every recorded call gets a result"
    // invariant: the result-dispatch loop dies, the turn fails, and
    // pendingToolResultIds stays open — stranding every later message in
    // deferredMessages.
    const base = new InMemoryAgentRecordPersistence();
    let failedOnce = false;
    const persistence: AgentRecordPersistence = {
      read: () => base.read(),
      append: (record: AgentRecord) => {
        if (
          !failedOnce &&
          record.type === 'context.append_loop_event' &&
          record.event.type === 'tool.result'
        ) {
          failedOnce = true;
          throw new Error('transcript write failed');
        }
        base.append(record);
      },
      rewrite: (records) => {
        base.rewrite(records);
      },
      flush: () => base.flush(),
      close: () => base.close(),
    };
    const ctx = testAgent({ kaos: createCommandKaos('ok'), persistence });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'I will run both commands.' },
      bashCallWithId('call_one', 'echo one'),
      bashCallWithId('call_two', 'echo two'),
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run both' }] });
    const events = await ctx.untilTurnEnd();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'failed' }),
      }),
    );

    // Every recorded tool.call must still get a result: the turn teardown
    // synthesizes an error result for each dangling call.
    const toolMessages = ctx.agent.context.history.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call_one', 'call_two']);
    for (const message of toolMessages) {
      expect(message.isError).toBe(true);
    }

    // With the exchange closed, a follow-up message reaches the history instead
    // of being stranded in deferredMessages forever.
    ctx.agent.context.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'follow-up after failure' }],
      toolCalls: [],
    });
    expect(JSON.stringify(ctx.agent.context.history)).toContain('follow-up after failure');
  });
});
