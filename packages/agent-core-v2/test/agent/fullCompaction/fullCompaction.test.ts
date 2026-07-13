/**
 * Scenario: full compaction refreshes, retries, and resumes agent context under
 * context-window pressure.
 *
 * Responsibilities: assert manual and automatic compaction outcomes, overflow
 * recovery, resume compatibility, dynamic tool context handling, and emitted
 * wire/telemetry effects. Wiring: testAgent harness with fake providers,
 * filesystem sandboxes, real compaction services, and stubs at external model /
 * telemetry boundaries. Run:
 * ../../node_modules/.bin/vitest run test/fullCompaction/full.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { UNKNOWN_CAPABILITY } from '#/app/llmProtocol/capability';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/app/llmProtocol/errors';
import { type Message, type StreamedMessagePart, type ToolCall } from '#/app/llmProtocol/message';
import { generate as runKosongGenerate } from '#/app/llmProtocol/generate';
import type { ChatProvider, StreamedMessage } from '#/app/llmProtocol/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultCompactionStrategy,
} from '#/agent/fullCompaction/strategy';
import { COMPACTION_SUMMARY_PREFIX } from '#/agent/contextMemory/compactionHandoff';
import { makeHookRunner } from '../externalHooks/runner-stub';
import type { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import { MASTER_ENV } from '#/app/flag/flagService';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import type { TestAgentContext, TestAgentOptions, TestAgentServiceOverride } from '../../harness';
import { appServices, createCommandRunner, execEnvServices, hostEnvironmentServices, sessionServices, testAgent } from '../../harness';
import {
  IAgentFullCompactionService,
  IOAuthService,
  IAgentProfileService,
  IAgentToolRegistryService,
  ISessionTodoService,
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  type ExecutableTool,
  type ResolvedAgentProfile,
  type ToolExecution,
} from '#/index';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentGoalService } from '#/agent/goal/goal';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;
const SNAPSHOT_VISIBLE_TOOLS = [
  'Agent',
  'AgentSwarm',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;
const LARGE_MCP_TOOL = 'mcp__srv__large';
const EXACT_COMPACTION_REFRESH_PROFILE: ResolvedAgentProfile = {
  name: 'exact-compaction-refresh',
  systemPrompt: (context) =>
    [
      `cwd:${context.cwd ?? ''}`,
      `os:${context.osKind ?? ''}`,
      `shell:${context.shellName ?? ''}:${context.shellPath ?? ''}`,
      `agents:${context.agentsMd ?? ''}`,
      `ls:${context.cwdListing ?? ''}`,
      `extra:${context.additionalDirsInfo ?? ''}`,
    ].join('\n'),
  tools: ['Read', 'Write', 'Skill'],
};

describe('FullCompaction', () => {
  it('keeps an oversized trailing user message as recent', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', `pending user ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('keeps consecutive trailing user messages as recent', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', `pending user one ${'x'.repeat(1_200)}`),
      textMessage('user', `pending user two ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('compacts the prefix when the trailing exchange itself is oversized', () => {
    const strategy = testCompactionStrategy();
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'recent user'),
      textMessage('assistant', `recent assistant ${'x'.repeat(1_200)}`),
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('returns 0 when there is nothing to compact', () => {
    const strategy = testCompactionStrategy();
    expect(strategy.computeCompactCount([], 'auto')).toBe(0);
    expect(strategy.computeCompactCount([textMessage('user', 'only pending')], 'auto')).toBe(0);
    expect(
      strategy.computeCompactCount(
        [
          textMessage('user', 'a'),
          textMessage('user', 'b'),
          textMessage('user', 'c'),
        ],
        'auto',
      ),
    ).toBe(0);
  });

  it('returns 0 when no intermediate split exists and the last message is also unsplittable', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'inspect'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' }],
      },
    ];

    expect(strategy.computeCompactCount(messages, 'auto')).toBe(0);
  });

  it('does not split inside a parallel tool exchange', () => {
    const strategy = testCompactionStrategy();
    const messages: Message[] = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      textMessage('user', 'run both tools'),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_a', name: 'Lookup', arguments: '{}' },
          { type: 'function', id: 'call_b', name: 'Lookup', arguments: '{}' },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: 'a' }], toolCalls: [], toolCallId: 'call_a' },
      { role: 'tool', content: [{ type: 'text', text: 'b' }], toolCalls: [], toolCallId: 'call_b' },
      textMessage('user', 'next prompt'),
    ];

    // The only valid split is before the parallel exchange (after 'old assistant'),
    // never between tool_a and tool_b — that would leave tool_b as an orphan.
    expect(strategy.computeCompactCount(messages, 'auto')).toBe(2);
  });

  it('reserves response context by default before the ratio threshold is reached', () => {
    const strategy = new DefaultCompactionStrategy(() => 256_000);

    expect(strategy.shouldCompact(210_000)).toBe(true);
    expect(strategy.shouldBlock(210_000)).toBe(true);
  });

  it('backs off overflow compaction by at least five percent of the context window', () => {
    const strategy = testCompactionStrategy(1_000);
    const messages = [
      textMessage('user', 'old user'),
      textMessage('assistant', 'old assistant'),
      ...Array.from({ length: 20 }, () => [
        textMessage('user', 'continue'),
        textMessage('assistant', ''),
      ]).flat(),
    ];

    const reduced = strategy.reduceCompactOnOverflow(messages);
    const removed = messages.slice(reduced);

    expect(reduced).toBeGreaterThan(0);
    expect(estimateTokensForMessages(removed)).toBeGreaterThanOrEqual(50);
  });

  it('ignores reserved context when the reserve is not smaller than the model window', () => {
    const strategy = new DefaultCompactionStrategy(() => 32_000, {
      triggerRatio: 0.85,
      blockRatio: 0.85,
      reservedContextSize: 50_000,
      maxCompactionPerTurn: 3,
      maxOverflowCompactionAttempts: 3,
      maxRecentMessages: 3,
      maxRecentUserMessages: Infinity,
      maxRecentSizeRatio: 0.2,
      minOverflowReductionRatio: 0.05,
    });

    expect(strategy.shouldCompact(1)).toBe(false);
    expect(strategy.shouldBlock(1)).toBe(false);
    expect(strategy.shouldCompact(28_000)).toBe(true);
    expect(strategy.shouldBlock(28_000)).toBe(true);
  });

  it('runs manual compaction and applies the compacted context', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => {
        resolve();
      });
    });
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;
    await completed;

    const events = ctx.newEvents();
    expect(countEvents(events, 'context.append_message')).toBeGreaterThanOrEqual(6);
    expect(countEvents(events, 'context.apply_compaction')).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.begin' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.started' }),
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.complete' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.completed' }),
      ]),
    );
    type WireCompleteEvent = {
      type: '[wire]';
      event: 'full_compaction.complete';
      args: Record<string, unknown>;
    };
    const completeEvent = events.find((event): event is WireCompleteEvent => {
      if (event === null || typeof event !== 'object') return false;
      const candidate = event as { type?: unknown; event?: unknown };
      return candidate.type === '[wire]' && candidate.event === 'full_compaction.complete';
    });
    // The engine stamps `time` on every persisted record; the payload itself is empty.
    expect(completeEvent?.args).toEqual({ time: '<time>' });
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, EnterPlanMode, ExitPlanMode
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "old user two"
        assistant: text "old assistant two"
        user: text "recent user three"
        assistant: text "recent assistant three"
        user: text <compaction-instruction>
    `);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'old user two' },
      { role: 'user', text: 'recent user three' },
      {
        role: 'user',
        text: expect.stringContaining('Compacted summary.'),
      },
    ]);
    expect(ctx.context.get().at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('The conversation so far has been compacted'),
    });
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'manual',
        tokens_before: 39,
        tokens_after: expect.any(Number),
        duration_ms: expect.any(Number),
        compacted_count: 6,
        retry_count: 0,
        thinking_effort: 'off',
        input_tokens: 1181,
        output_tokens: 8,
        input_cache_read: 0,
        input_cache_creation: 0,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('refreshes the active profile system prompt after compaction without resetting active tools', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-compact-refresh-home-'));
    const workDir = mkdtempSync(join(tmpdir(), 'kimi-compact-refresh-work-'));
    try {
      writeFileSync(join(workDir, 'AGENTS.md'), 'old project instructions', 'utf-8');
      const ctx = testAgent(
        execEnvServices({ hostFs: new HostFileSystem() }),
        hostEnvironmentServices(homeDir),
        { autoConfigure: false, cwd: workDir },
      );
      ctx.configureRuntimeModel(CATALOGUED_PROVIDER, CATALOGUED_MODEL_CAPABILITIES);
      const profile = ctx.get(IAgentProfileService);
      await profile.applyProfile(EXACT_COMPACTION_REFRESH_PROFILE);
      profile.update({ activeToolNames: ['Read'] });

      expect(profile.data().systemPrompt).toBe(
        exactCompactionRefreshPrompt(workDir, 'old project instructions'),
      );

      const refreshSpy = vi.spyOn(profile, 'refreshSystemPrompt');
      writeFileSync(join(workDir, 'AGENTS.md'), 'new project instructions', 'utf-8');
      ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
      ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
      const completed = ctx.once('compaction.completed');

      ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
      await ctx.rpc.beginCompaction({});
      await completed;

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(profile.data().systemPrompt).toBe(
        exactCompactionRefreshPrompt(workDir, 'new project instructions'),
      );
      expect(profile.getActiveToolNames()).toEqual(['Read']);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects a manual compaction while a turn is active', async () => {
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('should-not-run') }));
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: ['Bash'],
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.mockNextResponse({ type: 'text', text: 'I will wait for approval.' }, bashCall());

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the active turn' }] });
    const approval = await ctx.takeApprovalRequest();
    expect(ctx.get(IAgentLoopService).status().activeTurnId).toBeDefined();

    await expect(ctx.rpc.beginCompaction({})).rejects.toMatchObject({
      code: 'compaction.unable',
      message: 'Cannot compact while a turn is active. Wait for it to finish, then retry.',
    });
    const events = ctx.newEvents();
    expect(eventIndex(events, 'full_compaction.begin')).toBe(-1);
    expect(eventIndex(events, 'compaction.started')).toBe(-1);
    expect(ctx.get(IAgentFullCompactionService).compacting).toBeNull();
    expect(ctx.llmCalls).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'Turn done.' });
    approval.respond({ decision: 'rejected', selectedLabel: 'reject' });
    await ctx.untilTurnEnd();
    expect(ctx.get(IAgentLoopService).status().activeTurnId).toBeUndefined();
  });

  it('projects the compacted prefix before sending the summary request', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    await ctx.dispatch({
      type: 'context.append_message',
      message: { role: 'assistant', content: [], toolCalls: [] },
    });
    ctx.appendExchange(3, 'old user two', 'old assistant two', 40);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => {
        resolve();
      });
    });

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;

    const [compactionCall] = ctx.llmCalls;
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(
      compactionCall?.history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.length === 0 &&
          message.toolCalls.length === 0,
      ),
    ).toBe(false);
  });

  it('force-refreshes OAuth credentials on compaction 401 and falls back to login_required when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthTestAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length <= 2) {
        throw new APIStatusError(401, 'Unauthorized', 'req-compact-401');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const outcome = ctx.onceAny(['full_compaction.complete', 'error']);

    await ctx.rpc.beginCompaction({});

    expect(await outcome).toBe('error');
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        event: 'error',
        args: expect.objectContaining({
          code: 'auth.login_required',
          details: expect.objectContaining({
            statusCode: 401,
            requestId: 'req-compact-401',
          }),
        }),
      }),
    );
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);

    const retryOutcome = ctx.onceAny(['full_compaction.complete', 'error']);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});

    expect(await retryOutcome).toBe('full_compaction.complete');
    await completed;
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token', 'fresh-token']);
    expect(tokenCalls).toEqual([undefined, true, undefined]);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      {
        role: 'user',
        text: expect.stringContaining('Recovered compacted summary.'),
      },
    ]);
    await ctx.expectResumeMatches();
  });

  it('fires PreCompact and PostCompact hooks from the compaction module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-compact-hooks-'));
    const hookLog = join(dir, 'hooks.jsonl');
    const hookCommand = hookPayloadLoggerCommand(hookLog);
    const ctx = testAgent({
      hookEngine: makeHookRunner(
        [
          { event: 'PreCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
          { event: 'PostCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
        ],
        { cwd: dir },
      ),
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = ctx.once('full_compaction.complete');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.get(IAgentFullCompactionService).begin({ source: 'auto', instruction: undefined });
    await compacted;
    await vi.waitFor(() => {
      expect(readHookPayloads(hookLog).map((payload) => payload['hook_event_name'])).toEqual([
        'PreCompact',
        'PostCompact',
      ]);
    });

    const [pre, post] = readHookPayloads(hookLog);
    expect(pre).toMatchObject({
      hook_event_name: 'PreCompact',
      session_id: 'test-session',
      cwd: dir,
      trigger: 'auto',
      token_count: 39,
    });
    expect(post).toMatchObject({
      hook_event_name: 'PostCompact',
      session_id: 'test-session',
      cwd: dir,
      trigger: 'auto',
      estimated_token_count: ctx.contextData().tokenCount,
    });
  });

  it('cancels while waiting for a PreCompact hook', async () => {
    let preCompactSignal: AbortSignal | undefined;
    const trigger = vi.fn(
      async (_event: string, args?: { signal?: AbortSignal }) => {
        preCompactSignal = args?.signal;
        await new Promise<void>((resolve) => {
          args?.signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
        return [];
      },
    );
    const ctx = testAgent({ hookEngine: { trigger } as unknown as IExternalHooksRunnerService });

    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);

    void ctx.rpc.beginCompaction({ instruction: undefined });
    await vi.waitFor(() => {
      expect(preCompactSignal).toBeInstanceOf(AbortSignal);
    });
    const canceled = ctx.once('compaction.cancelled');
    void ctx.rpc.cancelCompaction({});
    await canceled;

    expect(trigger).toHaveBeenCalledWith(
      'PreCompact',
      expect.objectContaining({
        matcherValue: 'manual',
        inputData: expect.objectContaining({ trigger: 'manual' }),
      }),
    );
    expect(preCompactSignal?.aborted).toBe(true);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('reports compaction retry_count after a retryable generation failure recovers', async () => {
    const records: TelemetryRecord[] = [];
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new APIConnectionError('socket hang up');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(attempts).toBe(2);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'manual',
        tokens_before: 25,
        retry_count: 1,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('recovers from an image-format rejection with a media-stripped resend', async () => {
    // A poisoned image in the history makes the provider reject every request
    // with a deterministic image-format 400 — the summarizer request included.
    // The compaction must not fail: the requester resends once with every
    // media part replaced by a text marker (read-side only — the stored
    // history keeps its media), the only projection guaranteed to carry no
    // poison.
    let attempts = 0;
    let sawMedia = false;
    let sawStrippedResend = false;
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      const hasMedia = history.some((message) =>
        message.content.some((part) => part.type === 'image_url' || part.type === 'video_url'),
      );
      if (hasMedia) {
        sawMedia = true;
        throw new APIStatusError(400, 'unsupported image format: image/avif');
      }
      sawStrippedResend = true;
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    // Seeds an image_url and a video_url part — the poison the provider
    // rejects on every request until the media-stripped resend.
    ctx.appendRichToolExchange();
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(attempts).toBe(2);
    expect(sawMedia).toBe(true);
    expect(sawStrippedResend).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('recovers from a request-body 413 with a media-degraded resend', async () => {
    // A history bloated by accumulated base64 media gets rejected with HTTP
    // 413 — a body-size rejection, not a token overflow, so token-driven
    // recovery never fires. The requester resends once with the
    // media-degraded projection (all but the most recent media replaced by
    // text markers), which is enough to fit under the provider's byte limit.
    let attempts = 0;
    let sawFullMedia = false;
    let sawDegradedResend = false;
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      const mediaCount = history.reduce(
        (count, message) =>
          count +
          message.content.filter((part) => part.type === 'image_url' || part.type === 'video_url')
            .length,
        0,
      );
      if (mediaCount > 2) {
        sawFullMedia = true;
        throw new APIRequestTooLargeError(413, 'Request Entity Too Large');
      }
      sawDegradedResend = true;
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    // Two rich exchanges seed four media parts; the degraded projection keeps
    // only the two most recent.
    ctx.appendRichToolExchange();
    ctx.appendRichToolExchange();
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(attempts).toBe(2);
    expect(sawFullMedia).toBe(true);
    expect(sawDegradedResend).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('retries compaction responses with empty summaries before applying context', async () => {
    vi.useFakeTimers();
    const firstEmptySummary = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts <= 2) {
        if (attempts === 1) firstEmptySummary.resolve();
        return textResult(attempts === 1 ? '' : '   \n');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await firstEmptySummary.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;
    await completed;

    expect(attempts).toBe(3);
    // Empty summaries are retried without shrinking the history; the recovered
    // summary replaces the whole history with the real user messages plus the
    // prefixed summary.
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    expect(
      ctx.allEvents.filter((event) => event.event === 'compaction.completed'),
    ).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: expect.stringContaining('Recovered compacted summary.'),
          }),
        }),
      }),
    ]);
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('reduces the compacted prefix and retries when the model returns only thinking content', async () => {
    // End-to-end through the real kosong generate(): a think-only stream (think
    // parts, no text, no tool calls) makes generate() itself throw
    // APIEmptyResponseError. Compaction must treat that like a truncated summary
    // — shrink the compacted prefix and retry — rather than resend the identical
    // request that produced no summary.
    vi.useFakeTimers();
    const firstThinkOnly = deferred<void>();
    const inputs: string[][] = [];
    const generate = realKosongGenerate((attempt, history) => {
      inputs.push(inputHistorySnapshot(history));
      if (attempt === 1) {
        firstThinkOnly.resolve();
        return mockStreamedMessage([
          { type: 'think', think: 'Reasoning about the summary but never writing it...' },
        ]);
      }
      return mockStreamedMessage([{ type: 'text', text: 'Recovered compacted summary.' }]);
    });
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await firstThinkOnly.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;
    await completed;

    expect(inputs).toHaveLength(2);
    // The retry sends a strictly smaller input than the first attempt.
    expect(inputs[1]!.length).toBeLessThan(inputs[0]!.length);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('reduces the compacted prefix and retries when compaction receives plain 413', async () => {
    vi.useFakeTimers();
    const firstAttemptFailed = deferred<void>();
    let attempts = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      inputs.push(inputHistorySnapshot(history));
      if (attempts === 1) {
        firstAttemptFailed.resolve();
        throw new APIStatusError(413, 'Request Entity Too Large', 'req-compact-plain-413');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 20_000,
      },
    });
    ctx.appendExchange(1, 'old user one', `old assistant one ${'x'.repeat(45_000)}`, 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;
    await completed;

    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.length).toBeLessThan(inputs[0]!.length);
    const compactedHistory = ctx.compactHistory();
    expect(compactedHistory.some((message) => message.text.includes('old assistant one'))).toBe(false);
    expect(compactedHistory.some((message) => message.text.includes('Recovered compacted summary.'))).toBe(true);
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('fails after exhausting retries when the model only ever returns thinking content', async () => {
    // End-to-end through the real kosong generate(): every attempt is think-only,
    // so generate() keeps throwing APIEmptyResponseError. Compaction shrinks the
    // prefix on each retry but eventually exhausts MAX_COMPACTION_RETRY_ATTEMPTS
    // and fails without ever applying a summary.
    vi.useFakeTimers();
    const records: TelemetryRecord[] = [];
    const inputs: string[][] = [];
    const generate = realKosongGenerate((_attempt, history) => {
      inputs.push(inputHistorySnapshot(history));
      return mockStreamedMessage([
        { type: 'think', think: 'Still only thinking, no summary produced.' },
      ]);
    });
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;

    // Each empty/think-only response drops the oldest item and resets the retry
    // counter; once only one item remains, MAX_COMPACTION_RETRY_ATTEMPTS more
    // retries run before failing. 3 drops + 5 retries = 8 generate calls.
    expect(inputs).toHaveLength(8);
    expect(inputs[1]!.length).toBeLessThan(inputs[0]!.length);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        retry_count: 4,
        error_type: 'APIEmptyResponseError',
      }),
    });
    // No summary was ever applied; the original history is left intact.
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);
  });

  it('waits before retrying compaction generation after a retryable failure', async () => {
    vi.useFakeTimers();
    const firstAttemptFailed = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptFailed.resolve();
        throw new APIConnectionError('socket hang up');
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;
    await vi.advanceTimersByTimeAsync(299);

    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;

    expect(attempts).toBe(2);
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('cancels retry backoff without issuing another compaction request', async () => {
    vi.useFakeTimers();
    const firstAttemptFailed = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptFailed.resolve();
      }
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const cancelled = ctx.once('compaction.cancelled');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;

    void ctx.rpc.cancelCompaction({});
    await cancelled;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts).toBe(1);
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('cancels the compaction lifecycle when manual compaction generation fails', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw new Error('compaction exploded');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await failed;

    const events = ctx.newEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.cancel' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.cancelled' }),
        expect.objectContaining({ type: '[rpc]', event: 'error' }),
      ]),
    );
    expect(eventIndex(events, 'compaction.cancelled')).toBeLessThan(eventIndex(events, 'error'));
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        tokens_before: 25,
        duration_ms: expect.any(Number),
        round: 1,
        retry_count: 0,
        error_type: 'Error',
      }),
    });
    expect(
      records.find((record) => record.event === 'compaction_failed')?.properties,
    ).not.toHaveProperty('tokens_after');
    await ctx.expectResumeMatches();
  });

  it('fails a blocked turn when auto compaction generation fails', async () => {
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      throw new APIStatusError(400, 'Bad request');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: { ...CATALOGUED_MODEL_CAPABILITIES, max_context_tokens: 14 },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'x'.repeat(40) }] });
    const events = await ctx.untilTurnEnd();

    expect(attempts).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'error' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: {
          turnId: 0,
          reason: 'failed',
          error: expect.objectContaining({
            code: 'compaction.failed',
            message: 'APIStatusError: Bad request',
          }),
        },
      }),
    );
    const errorEvents = ctx.newEvents();
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({
      event: 'error',
      args: expect.objectContaining({
        code: 'compaction.failed',
        message: 'APIStatusError: Bad request',
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('names truncated compaction responses when retries are exhausted', async () => {
    vi.useFakeTimers();
    const firstAttemptFinished = deferred<void>();
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstAttemptFinished.resolve();
      }
      return {
        ...textResult('Partial summary.'),
        finishReason: 'truncated',
        rawFinishReason: 'length',
      };
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFinished.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;

    // The four-message compacted prefix shrinks on each truncated response.
    // Once only one message remains, it cannot shrink further, so the
    // CompactionTruncatedError fails immediately instead of falling through to
    // generic retry attempts.
    expect(attempts).toBe(4);
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        event: 'error',
        args: expect.objectContaining({
          code: 'compaction.failed',
          message:
            'CompactionTruncatedError: Compaction response was truncated before producing a complete summary.',
          name: 'Error2',
        }),
      }),
    );
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('reports compaction retry_count when retryable generation failures are exhausted', async () => {
    vi.useFakeTimers();
    const records: TelemetryRecord[] = [];
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      throw new APIConnectionError('socket hang up');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await vi.advanceTimersByTimeAsync(60_000);
    await failed;

    expect(attempts).toBe(5);
    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({
        source: 'manual',
        tokens_before: 25,
        duration_ms: expect.any(Number),
        retry_count: 4,
        error_type: 'APIConnectionError',
      }),
    });
    vi.useRealTimers();
    await ctx.expectResumeMatches();
  });

  it('renders rich compacted history without dropping non-text context', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendRichToolExchange();
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => {
        resolve();
      });
    });

    ctx.mockNextResponse({ type: 'text', text: 'Rich summary.' });
    const completed = ctx.once('compaction.completed');
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    await ctx.expectResumeMatches();
  });

  it('closes an unresolved tool exchange in the compaction prompt with a synthetic result', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendPartiallyResolvedParallelToolExchange();
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted before open tools.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep stable facts.' });
    await compacted;
    await completed;

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, EnterPlanMode, ExitPlanMode
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "run both tools"
        assistant: []  calls call_open_one:LookupOne { "query": "one" }, call_open_two:LookupTwo { "query": "two" }
        tool[call_open_one]: text "one result"
        tool[call_open_two]: text "Tool result is not available in the current context. Do not assume the tool completed successfully."
        user: text <compaction-instruction>
    `);
    expect(ctx.context.get().map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    await ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_open_two',
        toolCallId: 'call_open_two',
        result: { output: 'two result' },
      },
    });
    expect(ctx.context.get().map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    await ctx.expectResumeMatches();
  });

  it('keeps messages appended while compacting an unchanged prefix', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted prefix.' });
    await ctx.rpc.beginCompaction({});
    ctx.appendUserMessage([{ type: 'text', text: 'new user while compacting' }]);
    await compacted;
    await completed;

    const events = ctx.newEvents();
    expect(countEvents(events, 'context.append_message')).toBeGreaterThanOrEqual(5);
    expect(countEvents(events, 'context.apply_compaction')).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.begin' }),
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.complete' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.completed' }),
      ]),
    );
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, EnterPlanMode, ExitPlanMode
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text <compaction-instruction>
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`
      [
        {
          "role": "user",
          "text": "old user one",
        },
        {
          "role": "user",
          "text": "recent user two",
        },
        {
          "role": "user",
          "text": "new user while compacting",
        },
        {
          "role": "user",
          "text": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.
      Compacted prefix.",
        },
      ]
    `);
    await ctx.expectResumeMatches();
  });

  it('cancels a manual compaction when an assistant exchange is appended while compacting', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 4_000,
      },
    });
    ctx.appendExchange(
      1,
      `old user one ${'u'.repeat(14_000)}`,
      `old assistant one ${'a'.repeat(14_000)}`,
      6_000,
    );
    const firstSummary = `large manual summary ${'x'.repeat(14_000)}`;
    ctx.mockNextResponse({ type: 'text', text: firstSummary });
    const cancelled = ctx.once('compaction.cancelled');
    await ctx.rpc.beginCompaction({});
    ctx.appendExchange(2, 'new user while compacting', 'new assistant while compacting', 6_000);
    await cancelled;

    const events = ctx.newEvents();
    expect(countEvents(events, 'full_compaction.cancel')).toBe(1);
    expect(countEvents(events, 'compaction.started')).toBe(1);
    expect(countEvents(events, 'compaction.completed')).toBe(0);
    expect(ctx.llmCalls).toHaveLength(1);
    const [firstCompactionCall] = ctx.llmCalls;
    expect(firstCompactionCall?.history.map(messageText)).not.toContain('new user while compacting');
    expect(ctx.compactHistory()).toEqual([
      {
        role: 'user',
        text: `old user one ${'u'.repeat(14_000)}`,
      },
      {
        role: 'assistant',
        text: `old assistant one ${'a'.repeat(14_000)}`,
      },
      {
        role: 'user',
        text: 'new user while compacting',
      },
      {
        role: 'assistant',
        text: 'new assistant while compacting',
      },
    ]);
    await ctx.expectResumeMatches();
  });

  it('auto-compacts very large context in one full-history round when the summarizer accepts it', async () => {
    const maxContextTokens = 4_000;
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: maxContextTokens,
      },
    });
    for (let i = 1; i <= 22; i++) {
      ctx.appendAssistantTextWithUsage(
        i,
        `history chunk ${String(i)} ${'x'.repeat(7_200)}`,
        i * 1_850,
      );
    }
    const initialTokens = estimateTokensForMessages(ctx.context.get());
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Auto summary.' });

    ctx.get(IAgentFullCompactionService).begin({ source: 'auto', instruction: undefined });
    await completed;

    const events = ctx.newEvents();
    const compactedPrefixSizes = ctx.llmCalls.map((call) =>
      estimateTokensForMessages(call.history.slice(0, -1)),
    );
    expect(initialTokens).toBeGreaterThan(maxContextTokens * 9);
    expect(countEvents(events, 'full_compaction.complete')).toBe(1);
    expect(countEvents(events, 'compaction.completed')).toBe(1);
    expect(compactedPrefixSizes).toHaveLength(1);
    expect(compactedPrefixSizes[0]).toBe(initialTokens);
    expect(ctx.contextData().tokenCount).toBeLessThan(maxContextTokens * 0.85);
    await ctx.expectResumeMatches();
  });

  it('cancels when the compacted prefix changes before completion', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const canceled = ctx.once('full_compaction.cancel');

    ctx.mockNextResponse({ type: 'text', text: 'Stale summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.rpc.clearContext({});
    await canceled;

    const events = ctx.newEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.begin' }),
        expect.objectContaining({ type: '[wire]', event: 'context.clear' }),
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.cancel' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.cancelled' }),
      ]),
    );
    expect(eventIndex(events, 'full_compaction.begin')).toBeLessThan(
      eventIndex(events, 'context.clear'),
    );
    expect(eventIndex(events, 'context.clear')).toBeLessThan(
      eventIndex(events, 'full_compaction.cancel'),
    );
    expect(countEvents(events, 'context.apply_compaction')).toBe(0);
    expect(countEvents(events, 'full_compaction.complete')).toBe(0);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, EnterPlanMode, ExitPlanMode
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text <compaction-instruction>
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`[]`);
    await ctx.expectResumeMatches();
  });

  it('cancels when a droppable user-role tail is appended during the summary request', async () => {
    let ctx!: TestAgentContext;
    const generate: GenerateFn = async () => {
      ctx.appendSystemReminder('RACE-NOTIFY-OUTPUT', {
        kind: 'injection',
        variant: 'race-notification',
      });
      return textResult('Stale compacted summary.');
    };
    ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    const cancelled = ctx.once('compaction.cancelled');

    await ctx.rpc.beginCompaction({});
    await cancelled;

    expect(ctx.compactHistory().map((entry) => entry.text).join('\n')).toContain(
      'RACE-NOTIFY-OUTPUT',
    );
    expect(countEvents(ctx.newEvents(), 'full_compaction.complete')).toBe(0);
    await ctx.expectResumeMatches();
  });

  it('blocks the turn until auto compaction finishes', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 200);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 950_000);

    ctx.mockNextResponse({ type: 'text', text: 'Auto compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Answer after compacting' }] });

    const events = await ctx.untilTurnEnd();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: '[wire]', event: 'context.append_message' }),
        expect.objectContaining({ type: '[wire]', event: 'turn.prompt' }),
        expect.objectContaining({ type: '[rpc]', event: 'turn.started' }),
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.begin' }),
        expect.objectContaining({ type: '[rpc]', event: 'compaction.blocked' }),
        expect.objectContaining({ type: '[wire]', event: 'full_compaction.complete' }),
        expect.objectContaining({ type: '[rpc]', event: 'turn.step.started' }),
        expect.objectContaining({ type: '[rpc]', event: 'turn.ended' }),
      ]),
    );
    expect(eventIndex(events, 'turn.prompt')).toBeLessThan(
      eventIndex(events, 'full_compaction.begin'),
    );
    expect(eventIndex(events, 'full_compaction.begin')).toBeLessThan(
      eventIndex(events, 'full_compaction.complete'),
    );
    expect(eventIndex(events, 'compaction.blocked')).toBeLessThan(
      eventIndex(events, 'full_compaction.complete'),
    );
    expect(eventIndex(events, 'full_compaction.complete')).toBeLessThan(
      eventIndex(events, 'turn.step.started'),
    );
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Agent, AgentSwarm, EnterPlanMode, ExitPlanMode
        messages:
          user: text "old user one"
          assistant: text "old assistant one"
          user: text "old user two"
          assistant: text "old assistant two"
          user: text "recent user three"
          assistant: text "recent assistant three"
          user: text "Answer after compacting"
          user: text <compaction-instruction>

      call 2:
        messages:
          user: text "old user one\\n\\nold user two\\n\\nrecent user three\\n\\nAnswer after compacting"
          user: text "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nAuto compacted summary."
    `);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'auto',
        tokens_before: 46,
        tokens_after: 166,
        compacted_count: 7,
        retry_count: 0,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('keeps a deferred system reminder behind an unresolved tool exchange across compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendUnresolvedToolExchange(0);
    ctx.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // ContextMemory records raw insertion order — the reminder sits where it
    // was added, right after the still-open tool exchange.
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    // The projector guarantees ordering for the model: the open calls are
    // closed (synthetic results) and the reminder is placed after them, never
    // between a tool call and its results.
    expect(ctx.project().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    const compacted = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with open tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the in-flight tool exchange and the deferred reminder;
    // only real user messages and the compaction summary remain.
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.context.get().at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so late tool results are orphans
    // and do not change history.
    await ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_one',
        toolCallId: 'call_unresolved_one',
        result: { output: 'one result' },
      },
    });
    await ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
  });

  it('keeps a deferred system reminder behind a partially resolved tool exchange across compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendUnresolvedToolExchange(1);
    ctx.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // One tool result has landed but the second is still pending. Raw history
    // keeps insertion order (reminder after the partial exchange); the
    // projector keeps the real result, synthesizes the open one, and places the
    // reminder after the closed exchange.
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(ctx.project().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    const compacted = ctx.once('full_compaction.complete');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with partial tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the partially-resolved tool exchange and the deferred
    // reminder; only real user messages and the compaction summary remain.
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.context.get().at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so a late tool result is an
    // orphan and does not change history.
    await ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });
    expect(ctx.context.get().map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
  });

  it('compacts a single user message and keeps it ahead of the summary', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendUserMessage([{ type: 'text', text: 'only pending user' }]);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Single message summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'only pending user' },
      {
        role: 'user',
        text: `${COMPACTION_SUMMARY_PREFIX}\nSingle message summary.`,
      },
    ]);
    await ctx.expectResumeMatches();
  });

  it('manual compaction can run after a previous single-message compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    ctx.appendUserMessage([{ type: 'text', text: 'only pending user' }]);
    ctx.mockNextResponse({ type: 'text', text: 'Single message summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    ctx.clearContext();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('full_compaction.complete');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted after single-message compact.' });
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      {
        role: 'user',
        text: expect.stringContaining('Compacted after single-message compact.'),
      },
    ]);
    await ctx.expectResumeMatches();
  });

  it('rejects manual compaction with compaction.unable when history is empty', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    await expect(ctx.rpc.beginCompaction({})).rejects.toMatchObject({
      code: 'compaction.unable',
    });
    expect(ctx.llmCalls).toHaveLength(0);
    await ctx.expectResumeMatches();
  });

  it('does not auto compact small contexts when reserved size exceeds the model window', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { reservedContextSize: 50_000 },
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 32_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_000);

    ctx.mockNextResponse({ type: 'text', text: 'I can answer without reserved compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'small prompt' }] });
    const events = await ctx.untilTurnEnd();

    expect(eventIndex(events, 'compaction.started')).toBe(-1);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]?.history.map(messageText)).toContain('old assistant one');
    expect(messageText(ctx.llmCalls[0]?.history.at(-1))).toBe('small prompt');
    await ctx.expectResumeMatches();
  });

  it('does not trigger auto compaction from a deferred loaded MCP schema', async () => {
    vi.stubEnv(MASTER_ENV, '1');
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { reservedContextSize: 0 },
      },
    });
    const parameters = {
      type: 'object',
      properties: {
        payload: {
          type: 'string',
          description: 'x'.repeat(40_000),
        },
      },
    };
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 2_000,
        select_tools: true,
      },
      tools: [LARGE_MCP_TOOL],
    });
    const registration = ctx
      .get(IAgentToolRegistryService)
      .register(mcpTool(LARGE_MCP_TOOL, parameters), { source: 'mcp' });
    try {
      ctx.context.append({
        role: 'system',
        content: [],
        toolCalls: [],
        tools: [
          {
            name: LARGE_MCP_TOOL,
            description: `${LARGE_MCP_TOOL} desc`,
            parameters,
          },
        ],
        origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
      });
      ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

      ctx.mockNextResponse({ type: 'text', text: 'Answered without tool-schema compaction.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'small prompt' }] });
      const events = await ctx.untilTurnEnd();

      expect(eventIndex(events, 'compaction.started')).toBe(-1);
      expect(ctx.llmCalls).toHaveLength(1);
      expect(messageText(ctx.llmCalls[0]?.history.at(-1))).toBe('small prompt');
    } finally {
      registration.dispose();
    }
  });

  it('triggers auto compaction when pending tokens cross the reserved threshold', async () => {
    const ctx = testAgent({
      initialConfig: {
        providers: {},
        loopControl: { reservedContextSize: 500 },
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 2_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_400);

    ctx.mockNextResponse({ type: 'text', text: 'Reserved compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after reserved compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'x'.repeat(440) }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    expect(messageText(compactionCall?.history.at(-1))).toContain('first-person handoff note');
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Reserved compacted summary.')),
    ).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('includes an oversized pending user prompt in auto compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 2_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_650);
    const oversizedPrompt = `keep-this-pending-verbatim:${'x'.repeat(1_800)}`;

    ctx.mockNextResponse({ type: 'text', text: 'Oversized prompt summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer the oversized prompt.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: oversizedPrompt }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    const compactionTexts = compactionCall?.history.map(messageText) ?? [];
    // The whole history is compacted, so the pending prompt is included in the
    // compaction input and kept verbatim in the post-compaction replacement.
    expect(compactionTexts.some((text) => text.includes('keep-this-pending-verbatim'))).toBe(true);
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Oversized prompt summary.')),
    ).toBe(true);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('keep-this-pending-verbatim')),
    ).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('triggers auto compaction when pending tokens cross the ratio threshold', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 1_000_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 840_000);
    const pendingPrompt = `ratio-pending-verbatim:${'x'.repeat(60_000)}`;

    ctx.mockNextResponse({ type: 'text', text: 'Ratio compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer the ratio pending prompt.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: pendingPrompt }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const [compactionCall, answerCall] = ctx.llmCalls;
    const compactionTexts = compactionCall?.history.map(messageText) ?? [];
    // The whole history is compacted, so the pending prompt is included in the
    // compaction input and kept verbatim in the post-compaction replacement.
    expect(compactionTexts.some((text) => text.includes('ratio-pending-verbatim'))).toBe(true);
    expect(compactionCall?.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
    ]);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('Ratio compacted summary.')),
    ).toBe(true);
    expect(
      answerCall?.history.map(messageText).some((text) => text.includes('ratio-pending-verbatim')),
    ).toBe(true);

    await ctx.expectResumeMatches();
  });

  it('compacts and retries when the provider reports context overflow', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history, callbacks) => {
      callCount += 1;
      inputs.push(inputHistorySnapshot(history));
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-context-overflow');
      }
      if (callCount === 2) {
        return textResult('Overflow compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after overflow compaction.',
        });
        return textResult('Recovered after overflow compaction.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry after provider overflow' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.completed',
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: 'Overflow compacted summary.',
            compactedCount: 4,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
    expect(inputs).toMatchInlineSnapshot(`
      [
        [
          "user: old user one",
          "assistant: old assistant one",
          "user: Retry after provider overflow",
        ],
        [
          "user: old user one",
          "assistant: old assistant one",
          "user: Retry after provider overflow",
          "user: <compaction-instruction>",
        ],
        [
          "user: old user one

      Retry after provider overflow",
          "user: The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.
      Overflow compacted summary.",
        ],
      ]
    `);
    await ctx.expectResumeMatches();
  });

  it('remembers the observed provider context window after overflow', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-observed-window');
      }
      if (callCount === 2) {
        return textResult('Observed recovery summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after observed overflow.',
        });
        return textResult('Recovered after observed overflow.');
      }
      if (callCount === 4) {
        return textResult('Observed preemptive summary.');
      }
      if (callCount === 5) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Answered after observed-window precompaction.',
        });
        return textResult('Answered after observed-window precompaction.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
      },
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'learn observed window' }] });
    await ctx.untilTurnEnd();
    expect(callCount).toBe(3);

    ctx.appendExchange(2, 'near observed user', 'near observed assistant', 120_000);
    ctx.newEvents();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use observed window' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(5);
    expect(eventIndex(events, 'compaction.started')).toBeLessThan(
      eventIndex(events, 'turn.step.started'),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.completed',
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: 'Observed preemptive summary.',
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 1, reason: 'completed' },
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('recovers from plain 413 when estimated request is over effective max', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIStatusError(413, 'Request Entity Too Large', 'req-plain-413');
      }
      if (callCount === 2) {
        return textResult('Plain 413 compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered after plain 413 compaction.',
      });
      return textResult('Recovered after plain 413 compaction.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
      },
    });
    ctx.appendExchange(1, 'old user one', `old assistant one ${'x'.repeat(600_000)}`, 150_000);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry after plain 413' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.completed',
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: 'Plain 413 compacted summary.',
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('does not compact plain 413 when estimated request is small', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(413, 'Request Entity Too Large', 'req-small-413');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'small prompt' }] });
    const events = await ctx.untilTurnEnd();

    expect(eventIndex(events, 'compaction.started')).toBe(-1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ turnId: 0, reason: 'failed' }),
      }),
    );
    await ctx.expectResumeMatches();
  });

  it('does not reset the step budget after provider context overflow compaction', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-budget-overflow');
      }
      if (callCount === 2) {
        return textResult('Budget compacted summary.');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Should not run.' });
      return textResult('Should not run.');
    };
    const ctx = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry after provider overflow' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(2);
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
    await ctx.expectResumeMatches();
  });

  it('preserves thinking effort when compacting after provider context overflow', async () => {
    let callCount = 0;
    const records: TelemetryRecord[] = [];
    const providerThinkingEfforts: Array<Parameters<GenerateFn>[0]['thinkingEffort']> = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      providerThinkingEfforts.push(provider.thinkingEffort);
      if (callCount === 1) {
        throw new APIContextOverflowError(
          400,
          'Context length exceeded',
          'req-thinking-context-overflow',
        );
      }
      if (callCount === 2) {
        return textResult('Thinking compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after thinking compaction.',
        });
        return textResult('Recovered after thinking compaction.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.get(IAgentProfileService).update({ thinkingLevel: 'high' });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with thinking preserved' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    // The catalogued model declares no supportEfforts, so the Kimi provider
    // normalizes to boolean thinking and reports 'on' rather than the
    // requested 'high'. The stored thinkingLevel still carries 'high' across
    // compaction, which is asserted through telemetry below.
    expect(providerThinkingEfforts).toEqual(['on', 'on', 'on']);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'auto',
        thinking_effort: 'high',
      }),
    });
  });

  it('compacts provider overflow when model context size is unknown', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-unknown-context');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Unknown window compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered with unknown context size.',
        });
        return textResult('Recovered with unknown context size.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    const modelResolver = ctx.modelResolver;
    if (modelResolver === undefined) throw new Error('Expected model provider');
    const resolve = modelResolver.resolve.bind(modelResolver);
    modelResolver.resolve = (model: string) => {
      const resolved = resolve(model);
      Object.defineProperty(resolved, 'capabilities', { value: UNKNOWN_CAPABILITY });
      return resolved;
    };
    expect(ctx.get(IAgentProfileService).data().modelCapabilities.max_context_tokens).toBe(0);
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry without known model window' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([32000]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.completed',
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: 'Unknown window compacted summary.',
            compactedCount: 4,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
  });

  it('honors completion budget env hard caps during compaction', async () => {
    vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', '8192');
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-hard-cap');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Hard cap compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with hard cap.',
      });
      return textResult('Recovered with hard cap.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with hard cap' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([8192]);
  });

  it.each(['0', '-1'])(
    'honors completion budget env opt-out (%s) during compaction',
    async (maxCompletionTokens) => {
      vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', maxCompletionTokens);
      let callCount = 0;
      const compactionMaxCompletionTokens: unknown[] = [];
      const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
        callCount += 1;
        if (callCount === 1) {
          throw new APIContextOverflowError(400, 'Context length exceeded', 'req-opt-out');
        }
        if (callCount === 2) {
          compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
          return textResult('Opt-out compacted summary.');
        }
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered with opt-out.',
        });
        return textResult('Recovered with opt-out.');
      };
      const ctx = testAgent({ generate });
      ctx.configure({
        provider: CATALOGUED_PROVIDER,
        modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
      });
      ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
      ctx.newEvents();

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with opt-out' }] });
      await ctx.untilTurnEnd();

      expect(callCount).toBe(3);
      expect(compactionMaxCompletionTokens).toEqual([undefined]);
    },
  );

  it('honors maxOutputSize from model config during compaction', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-max-output');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Max output compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with max output.',
      });
      return textResult('Recovered with max output.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    // Set maxOutputSize on the harness's internal kimiConfig. Keep it below
    // the Kimi model context window so provider-side context clipping does not
    // hide whether compaction passed this configured value through.
    const models = (ctx as unknown as MutableKimiConfig).kimiConfig.models;
    models![CATALOGUED_PROVIDER.model] = {
      ...models![CATALOGUED_PROVIDER.model]!,
      maxOutputSize: 64_000,
    };
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with max output' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([64_000]);
  });

  it('uses default 128k hardCap when maxOutputSize is not configured', async () => {
    let callCount = 0;
    const compactionMaxCompletionTokens: unknown[] = [];
    const generate: GenerateFn = async (provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-default-cap');
      }
      if (callCount === 2) {
        compactionMaxCompletionTokens.push(providerMaxCompletionTokens(provider));
        return textResult('Default cap compacted summary.');
      }
      await callbacks?.onMessagePart?.({
        type: 'text',
        text: 'Recovered with default cap.',
      });
      return textResult('Recovered with default cap.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with default cap' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([128 * 1024]);
  });

  it('ignores filtered assistant placeholders when checking the retained overflow suffix', async () => {
    let callCount = 0;
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history, callbacks) => {
      callCount += 1;
      inputs.push(inputHistorySnapshot(history));
      if (callCount === 1) {
        throw new APIContextOverflowError(
          400,
          'Context length exceeded',
          'req-placeholder-boundary',
        );
      }
      if (callCount === 2) {
        return textResult('Placeholder compacted summary.');
      }
      if (callCount === 3) {
        await callbacks?.onMessagePart?.({
          type: 'text',
          text: 'Recovered after ignoring the placeholder.',
        });
        return textResult('Recovered after ignoring the placeholder.');
      }
      throw new Error(`Unexpected generate call ${String(callCount)}`);
    };
    const ctx = testAgent({
      generate,
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 14,
      },
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 1);
    const promptThatFitsWithoutPlaceholder = 'x'.repeat(40);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: promptThatFitsWithoutPlaceholder }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.completed',
        args: expect.objectContaining({
          result: expect.objectContaining({
            summary: 'Placeholder compacted summary.',
            compactedCount: 3,
            droppedCount: 2,
          }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: { turnId: 0, reason: 'completed' },
      }),
    );
    expect(inputs).toMatchInlineSnapshot(`
      [
        [
          "user: old user one",
          "assistant: old assistant one",
          "user: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "user: <compaction-instruction>",
        ],
        [
          "user: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "user: <compaction-instruction>",
        ],
        [
          "user: old user one

      xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "user: The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.
      Placeholder compacted summary.",
        ],
      ]
    `);
  });


  it('appends the todo list to the compaction summary', async () => {
    const todos = [
      { title: 'Fix the auth bug', status: 'in_progress' },
      { title: 'Add tests', status: 'pending' },
    ] as const;
    const ctx = testAgent(
      sessionServices((reg) => {
        reg.definePartialInstance(ISessionTodoService, {
          getTodos: () => todos,
        });
      }),
    );
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);

    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => {
        resolve();
      });
    });
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    const history = ctx.compactHistory();
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      role: 'user',
      text: 'old user one',
    });
    expect(history[1]).toMatchObject({
      role: 'user',
      text: 'recent user two',
    });
    expect(history[2]).toMatchObject({
      role: 'user',
      text: expect.stringContaining(
        'Compacted summary.\n\n## TODO List\n  [in_progress] Fix the auth bug\n  [pending] Add tests',
      ),
    });
    expect(ctx.context.get().at(-1)?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('The conversation so far has been compacted'),
    });
    await ctx.expectResumeMatches();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventIndex(events: ReturnType<TestAgentContext['newEvents']>, type: string): number {
  return events.findIndex((event) => {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { readonly event?: unknown }).event === type;
  });
}

function countEvents(events: ReturnType<TestAgentContext['newEvents']>, type: string): number {
  return events.filter((event) => {
    if (typeof event !== 'object' || event === null) return false;
    return (event as { readonly event?: unknown }).event === type;
  }).length;
}

function exactCompactionRefreshPrompt(workDir: string, agentsMd: string): string {
  return [
    `cwd:${workDir}`,
    'os:Linux',
    'shell:bash:/bin/bash',
    `agents:<!-- From: ${join(workDir, 'AGENTS.md')} -->\n${agentsMd}`,
    'ls:\u2514\u2500\u2500 AGENTS.md',
    'extra:',
  ].join('\n');
}

function oauthTestAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
): {
  readonly initialConfig: TestAgentOptions['initialConfig'];
  readonly services: TestAgentServiceOverride;
} {
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
        },
      },
    },
    services: appServices((reg) => {
      reg.definePartialInstance(IOAuthService, {
        resolveTokenProvider: () => ({ getAccessToken }),
      });
    }),
  };
}

type MutableKimiConfig = {
  kimiConfig: {
    models?: Record<string, { maxOutputSize?: number }>;
  };
};

function providerMaxCompletionTokens(provider: Parameters<GenerateFn>[0]): unknown {
  return (
    provider as {
      readonly modelParameters?: Record<string, unknown>;
    }
  ).modelParameters?.['max_completion_tokens'];
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-compaction-oauth-retry',
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

function mockStreamedMessage(parts: readonly StreamedMessagePart[]): StreamedMessage {
  return {
    get id(): string | null {
      return 'mock-stream';
    },
    get usage() {
      return null;
    },
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

// Runs the REAL kosong generate() over a scripted provider stream so think-only
// and empty responses exercise kosong's actual APIEmptyResponseError path rather
// than a mocked generate function that throws directly.
function realKosongGenerate(
  script: (attempt: number, history: readonly Message[]) => StreamedMessage,
): GenerateFn {
  let attempt = 0;
  return (chat, systemPrompt, tools, history, callbacks, options) => {
    attempt += 1;
    const currentAttempt = attempt;
    const provider: ChatProvider = {
      name: 'mock-think-only',
      modelName: chat.modelName,
      thinkingEffort: chat.thinkingEffort,
      generate: () => Promise.resolve(script(currentAttempt, history)),
      withThinking() {
        return provider;
      },
    };
    return runKosongGenerate(provider, systemPrompt, tools, history, callbacks, options);
  };
}

function testCompactionStrategy(maxSize: number = 1_000): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: 0.85,
    blockRatio: 0.85,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
    maxRecentMessages: 10,
    maxRecentUserMessages: Infinity,
    maxRecentSizeRatio: 0.2,
    minOverflowReductionRatio: 0.05,
  });
}

function overflowOnlyCompactionStrategy(maxSize: number = 14): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: Infinity,
    blockRatio: Infinity,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
    maxRecentMessages: 3,
    maxRecentUserMessages: Infinity,
    maxRecentSizeRatio: 0.2,
    minOverflowReductionRatio: 0.05,
  });
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function mcpTool(
  name: string,
  parameters: Record<string, unknown>,
): ExecutableTool<Record<string, unknown>> {
  return {
    name,
    description: `${name} desc`,
    parameters,
    resolveExecution(): ToolExecution {
      return {
        approvalRule: name,
        execute: async () => ({ output: 'mcp ok' }),
      };
    },
  };
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: JSON.stringify({ command: 'printf should-not-run', timeout: 60 }),
  };
}

function messageText(message: Message | undefined): string {
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

function hookPayloadLoggerCommand(logPath: string): string {
  // Write the hook script to a file and run it with node, instead of
  // `node -e <json>`; cmd.exe on Windows mangles the escaped quotes in the
  // inline form and corrupts the script before it can run.
  const scriptPath = `${logPath}.cjs`;
  const script = [
    "const fs = require('node:fs');",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    `  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(JSON.parse(input)) + '\\n');`,
    '});',
  ].join('');
  writeFileSync(scriptPath, script);
  return `${process.execPath} ${scriptPath}`;
}

function readHookPayloads(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf-8').trim();
  if (text.length === 0) return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function inputHistorySnapshot(history: readonly Message[]): string[] {
  return history.map((message) => {
    const text = message.content
      .map((part) => (part.type === 'text' ? normalizeInputText(part.text) : ''))
      .join('');
    return `${message.role}: ${text}`;
  });
}

function normalizeInputText(text: string): string {
  return text.includes('first-person handoff note') ? '<compaction-instruction>' : text;
}

describe('prompt deferral during full compaction', () => {
  it('defers a prompt submitted mid-compaction and replays it after completion', async () => {
    const compactionRequested = deferred<void>();
    const releaseCompaction = deferred<void>();
    let llmCallCount = 0;
    const llmInputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      llmCallCount += 1;
      llmInputs.push(history.map(messageText));
      if (llmCallCount === 1) {
        compactionRequested.resolve();
        await releaseCompaction.promise;
        return textResult('Compacted summary.');
      }
      return textResult('Deferred turn reply.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compactionRequested.promise;
    const launch = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'deferred prompt' }],
    });
    expect(launch).toBeUndefined();

    releaseCompaction.resolve();
    await completed;
    const events = await ctx.untilTurnEnd();

    expect(countEvents(events, 'compaction.cancelled')).toBe(0);
    expect(countEvents(events, 'compaction.completed')).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    expect(llmCallCount).toBe(2);
    const turnHistory = llmInputs.at(-1) ?? [];
    expect(turnHistory.some((text) => text.includes('Compacted summary.'))).toBe(true);
    expect(turnHistory).toContain('deferred prompt');
    await ctx.expectResumeMatches();
  });

  it('replays a prompt deferred during compaction after the compaction fails', async () => {
    const compactionRequested = deferred<void>();
    const releaseCompaction = deferred<void>();
    let llmCallCount = 0;
    const llmInputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      llmCallCount += 1;
      llmInputs.push(history.map(messageText));
      if (llmCallCount === 1) {
        compactionRequested.resolve();
        await releaseCompaction.promise;
        throw new Error('compaction exploded');
      }
      return textResult('Recovered turn reply.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const cancelled = ctx.once('compaction.cancelled');

    await ctx.rpc.beginCompaction({});
    await compactionRequested.promise;
    const launch = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'deferred prompt' }],
    });
    expect(launch).toBeUndefined();

    releaseCompaction.resolve();
    await cancelled;
    const events = await ctx.untilTurnEnd();

    expect(countEvents(events, 'compaction.completed')).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    expect(llmCallCount).toBe(2);
    const turnHistory = llmInputs.at(-1) ?? [];
    expect(turnHistory).toContain('deferred prompt');
    expect(turnHistory.some((text) => text.includes('Compacted'))).toBe(false);
    await ctx.expectResumeMatches();
  });
});

describe('goal reminder re-injection after full compaction', () => {
  const GOAL_OBJECTIVE = 'ship the goal parity fixes';

  function goalReminderCount(history: readonly Message[] | readonly string[]): number {
    const texts =
      typeof history[0] === 'string'
        ? (history as readonly string[])
        : (history as readonly Message[]).map(messageText);
    return texts.filter((text) => text.includes(GOAL_OBJECTIVE) && text.includes('active goal'))
      .length;
  }

  it('re-injects the goal reminder before the first post-compaction request', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.get(IAgentGoalService).createGoal({ objective: GOAL_OBJECTIVE });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 950_000);

    ctx.mockNextResponse({ type: 'text', text: 'Auto compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Answer after compacting' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(2);
    expect(goalReminderCount(ctx.llmCalls[0]!.history)).toBe(0);
    expect(goalReminderCount(ctx.llmCalls[1]!.history)).toBe(1);
  });

  it('counts the re-injected goal reminder into the post-compaction token floor', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.get(IAgentGoalService).createGoal({ objective: GOAL_OBJECTIVE });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    const reminderMessages = ctx.context
      .get()
      .filter(
        (message) => message.origin?.kind === 'injection' && message.origin.variant === 'goal',
      );
    expect(reminderMessages).toHaveLength(1);

    const tokensAfter = records.find((record) => record.event === 'compaction_finished')
      ?.properties?.['tokens_after'];
    expect(typeof tokensAfter).toBe('number');
    const floor = (
      ctx.get(IAgentFullCompactionService) as unknown as {
        lastCompactedTokenCount: number | null;
      }
    ).lastCompactedTokenCount;
    expect(floor).toBe(ctx.get(IAgentContextSizeService).get().size);
    expect(floor!).toBeGreaterThan(tokensAfter as number);

    // V1-parity quirk (reproduced deliberately): after an idle manual compact,
    // the next turn's per-turn injection adds a second copy of the reminder.
    ctx.mockNextResponse({ type: 'text', text: 'Reply after compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'next prompt' }] });
    await ctx.untilTurnEnd();
    expect(goalReminderCount(ctx.llmCalls.at(-1)!.history)).toBe(2);
  });

  it('replays a deferred prompt whose first request carries the re-injected goal reminder', async () => {
    const compactionRequested = deferred<void>();
    const releaseCompaction = deferred<void>();
    let llmCallCount = 0;
    const llmInputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      llmCallCount += 1;
      llmInputs.push(history.map(messageText));
      if (llmCallCount === 1) {
        compactionRequested.resolve();
        await releaseCompaction.promise;
        return textResult('Compacted summary.');
      }
      if (llmCallCount === 2) return textResult('Deferred turn reply.');
      throw new Error(`Unexpected generate call #${String(llmCallCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.get(IAgentGoalService).createGoal({ objective: GOAL_OBJECTIVE });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compactionRequested.promise;
    const launch = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'deferred prompt' }],
    });
    expect(launch).toBeUndefined();

    releaseCompaction.resolve();
    await completed;
    await ctx.untilTurnEnd();

    const turnRequest = llmInputs[1] ?? [];
    expect(turnRequest).toContain('deferred prompt');
    expect(goalReminderCount(turnRequest)).toBeGreaterThanOrEqual(1);
    expect(turnRequest.some((text) => text.includes('Compacted summary.'))).toBe(true);
  });
});
