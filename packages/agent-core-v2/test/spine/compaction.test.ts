import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { MASTER_ENV } from '#/app/flag/flagService';
import { ACCEPTED_OUTPUT, IAgentSpineService } from '#/index';

import {
  execEnvServices,
  logServices,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
} from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';
const MINUTE = 60 * 1000;
type GenerateFn = NonNullable<TestAgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

describe('Spine / compaction interaction', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('routes full compaction into a spine root epoch instead of rebuilding history', async () => {
    vi.useFakeTimers();
    const ctx = testAgent();
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = (await ctx.wireHistory()).map((record) => record.type);
    expect(recordTypes).not.toContain('spine.root_compact');
    expect(recordTypes).not.toContain('context.apply_compaction');

    const state = readSpine(ctx);
    expect(state.rootEpoch).toBe(2);
    expect(state.openStack).toEqual(['2', '2.1']);
    expect(state.epochMemoryAt).toBeDefined();

    const lastMessage = ctx.context.get().at(-1);
    expect(lastMessage?.origin?.kind).toBe('compaction_summary');
    expect(textOf(lastMessage)).toContain('Summary.');

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('old assistant'))).toBe(false);
    expect(textOf(projected[0])).toContain('Summary.');
  });

  it('archives the folded-out context and publishes the path on the new epoch node', async () => {
    vi.useFakeTimers();
    const writes = new Map<string, string>();
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs(writes) }));
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const archivePath = [...writes.keys()].find((path) =>
      path.endsWith('/agents/main/spine/2.md'),
    );
    expect(archivePath).toBeDefined();
    const content = writes.get(archivePath!) ?? '';
    expect(content).toContain('# Spine Root Epoch 2');
    expect(content).toContain('## Epoch Summary');
    expect(content).toContain('Summary.');
    expect(content).toContain('## Trajectory');
    expect(content).toContain('old user');
    expect(content).toContain('old assistant');
    expect(content).toContain('recent user');
    expect(content).toContain('recent assistant');

    expect(ctx.get(IAgentSpineService).renderTree()).toContain(archivePath!);
  });

  it('completes the root compaction without an archive path when the archive write fails', async () => {
    vi.useFakeTimers();
    const logEntries: Array<{ level: string; message: string }> = [];
    const ctx = testAgent(
      execEnvServices({ hostFs: failingHostFs() }),
      logServices(recordingLogger(logEntries)),
    );
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);

    vi.setSystemTime(61 * MINUTE);
    const completed = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const recordTypes = (await ctx.wireHistory()).map((record) => record.type);
    expect(recordTypes).not.toContain('spine.root_compact');
    expect(recordTypes).toContain('full_compaction.complete');
    const tree = ctx.get(IAgentSpineService).renderTree();
    expect(tree).toContain('2 [open]');
    expect(tree).not.toContain('2.md');
    expect(
      logEntries.some(
        (entry) => entry.level === 'warn' && entry.message.toLowerCase().includes('archive'),
      ),
    ).toBe(true);
  });

  it('keeps previous epochs and their archive paths reachable in the tree after a root compaction', () => {
    const ctx = testAgent();
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('c_open'));
    append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
    append(ctx, spineAcceptedReceipt('c_close'));
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));

    const tree = ctx.get(IAgentSpineService).renderTree();

    expect(tree).toContain('1 [closed]');
    expect(tree).toContain('1.1.1');
    expect(tree).toContain('task A');
    expect(tree).toContain('archive:');
    expect(tree).toContain('1-1-1.md');
    expect(tree).toContain('2 [open, archive:');
  });

  it('summarizes only the current epoch and chains the previous epoch summary', async () => {
    const summaryInputs: string[] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      const text = history.map((message) => textOf(message)).join('\n');
      if (text.includes('You are about to run out of context.')) summaryInputs.push(text);
      return {
        id: 'mock-epoch-summary',
        message: { role: 'assistant', content: [{ type: 'text', text: 'epoch summary' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const ctx = testAgent({ generate });
    ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });

    ctx.appendExchange(1, 'EPOCH-ONE-MARKER old user', 'old assistant', 20);
    const first = ctx.once('full_compaction.complete');
    await ctx.rpc.beginCompaction({});
    await first;

    ctx.appendExchange(2, 'EPOCH-TWO-MARKER new user', 'new assistant', 20);
    summaryInputs.length = 0;
    const second = ctx.once('full_compaction.complete');
    await ctx.rpc.beginCompaction({});
    await second;

    expect(summaryInputs).toHaveLength(1);
    const input = summaryInputs[0]!;
    expect(input).toContain('EPOCH-TWO-MARKER');
    expect(input).toContain('epoch summary');
    expect(input).not.toContain('EPOCH-ONE-MARKER');
  });
});

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentSpineService).currentState();
}

function append(ctx: TestAgentContext, message: ContextMessage): number {
  const index = ctx.context.get().length;
  ctx.context.append(message);
  return index;
}

function assistantToolCall(id: string, name: string, args: string = '{}'): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: args }],
  };
}

function spineAcceptedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
}

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function failingHostFs() {
  return {
    writeText: async () => {
      throw new Error('disk full');
    },
    mkdir: async () => {},
  };
}

function recordingLogger(entries: Array<{ level: string; message: string }>) {
  const record = (level: string) => (message: string) => {
    entries.push({ level, message });
  };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content
      ?.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('') ?? ''
  );
}
