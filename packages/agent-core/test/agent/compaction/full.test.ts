import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIRequestTooLargeError,
  APIStatusError,
  generate as runKosongGenerate,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type Message,
  type StreamedMessage,
  type StreamedMessagePart,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KimiConfig } from '../../../src/config';
import type { AgentOptions } from '../../../src/agent';
import {
  COMPACTION_SUMMARY_PREFIX,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from '../../../src/agent/compaction';
import { FLAG_DEFINITIONS, MASTER_ENV } from '../../../src/flags';
import { HookEngine, type HookEngineTriggerArgs } from '../../../src/session/hooks';
import { estimateTokens, estimateTokensForMessages } from '../../../src/utils/tokens';
import { recordingTelemetry, type TelemetryRecord } from '../../fixtures/telemetry';
import type { TestAgentContext, TestAgentOptions } from '../harness/agent';
import { testAgent } from '../harness/agent';

type GenerateFn = NonNullable<AgentOptions['generate']>;

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
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
const MICRO_COMPACTION_FLAG_ENV = getMicroCompactionFlagEnv();

describe('FullCompaction', () => {
  it('runs manual compaction and applies the compacted context', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
        resolve();
      });
    });
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;
    await completed;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user three" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin      { "source": "manual", "instruction": "Keep the important test facts.", "time": "<time>" }
      [emit] compaction.started         { "trigger": "manual", "instruction": "Keep the important test facts." }
      [wire] llm.tools_snapshot         { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                { "kind": "compaction", "provider": "kimi", "model": "kimi-code", "modelAlias": "kimi-code", "thinkingEffort": "off", "maxTokens": 131072, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 7, "droppedCount": 0, "time": "<time>" }
      [wire] usage.record               { "model": "kimi-code", "usage": { "inputOther": 1181, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 120, "maxContextTokens": 256000, "contextUsage": 0.00046875, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1181, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1181, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction   { "summary": "Compacted summary.", "contextSummary": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nCompacted summary.", "compactedCount": 6, "tokensBefore": 39, "tokensAfter": 158, "keptUserMessageCount": 3, "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 158, "maxContextTokens": 256000, "contextUsage": 0.0006171875, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1181, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1181, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete   { "time": "<time>" }
      [emit] compaction.completed       { "result": { "summary": "Compacted summary.", "compactedCount": 6, "tokensBefore": 39, "tokensAfter": 158, "keptUserMessageCount": 3 } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "old user two"
        assistant: text "old assistant two"
        user: text "recent user three"
        assistant: text "recent assistant three"
        user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history.\\n\\n\\nOptional user instruction:\\nKeep the important test facts."
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`
      [
        {
          "role": "user",
          "text": "old user one",
        },
        {
          "role": "user",
          "text": "old user two",
        },
        {
          "role": "user",
          "text": "recent user three",
        },
        {
          "role": "user",
          "text": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.
      Compacted summary.",
        },
      ]
    `);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'manual',
        tokens_before: 39,
        tokens_after: 158,
        duration_ms: expect.any(Number),
        compacted_count: 6,
        retry_count: 0,
        thinking_effort: 'off',
        input_tokens: 1181,
        output_tokens: 8,
      }),
    });
    await ctx.expectResumeMatches();
  });

  it('attaches the summarizer request trace id to compaction_finished', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'Compacted summary.' }],
      traceId: 'trace-compact-1',
    });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({ source: 'manual', trace_id: 'trace-compact-1' }),
    });
    expect(ctx.agent.fullCompaction.lastTraceId).toBe('trace-compact-1');
  });

  it('attaches the failed summarizer request trace id to compaction_failed', async () => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      // 401 is not retryable: the round fails on the first attempt without
      // backoff timers.
      throw new APIStatusError(401, 'Unauthorized', 'req-1', null, 'trace-compact-err');
    };
    const ctx = testAgent({ generate, telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    const failed = ctx.once('error');

    await ctx.rpc.beginCompaction({});
    await failed;

    expect(records).toContainEqual({
      event: 'compaction_failed',
      properties: expect.objectContaining({ source: 'manual', trace_id: 'trace-compact-err' }),
    });
  });

  it('emits the raw summary while keeping the prefixed summary in model context', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const completedEvent = ctx.allEvents.find((entry) => entry.event === 'compaction.completed');
    expect(completedEvent?.args).toEqual({
      result: expect.objectContaining({
        summary: 'Compacted summary.',
      }),
    });
    expect(completedEvent?.args).not.toEqual({
      result: expect.objectContaining({
        summary: expect.stringContaining(COMPACTION_SUMMARY_PREFIX),
      }),
    });
    expect(ctx.agent.context.history.at(-1)?.content).toEqual([
      { type: 'text', text: `${COMPACTION_SUMMARY_PREFIX}\nCompacted summary.` },
    ]);
  });

  it('keeps only real user input and re-injects permission reminders after compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'real user one', 'assistant one', 20);
    ctx.agent.context.appendBashInput('pwd');
    ctx.agent.context.appendBashOutput('/tmp/repo', '', false);
    ctx.agent.context.appendLocalCommandStdout('local command output');
    ctx.agent.context.appendSystemReminder('stale reminder', {
      kind: 'injection',
      variant: 'system_reminder',
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'background task done' }], {
      kind: 'background_task',
      taskId: 'task-1',
      status: 'completed',
      notificationId: 'notification-1',
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'real user two' }]);
    ctx.agent.permission.setMode('auto');

    const permissionReminder = new Promise<void>((resolve) => {
      const handler = (entry: unknown) => {
        const record = entry as {
          event?: string;
          args?: { message?: { origin?: { kind?: string; variant?: string } } };
        };
        const origin = record.args?.message?.origin;
        if (
          record.event === 'context.append_message' &&
          origin?.kind === 'injection' &&
          origin.variant === 'permission_mode'
        ) {
          ctx.emitter.off('context.append_message', handler);
          resolve();
        }
      };
      ctx.emitter.on('context.append_message', handler);
    });

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');
    await permissionReminder;

    expect(ctx.agent.context.history.map((message) => message.origin?.kind ?? 'user')).toEqual([
      'user',
      'user',
      'compaction_summary',
      'injection',
    ]);
    expect(
      ctx.agent.context.history.map((message) =>
        message.origin?.kind === 'injection' ? message.origin.variant : undefined,
      ),
    ).toEqual([undefined, undefined, undefined, 'permission_mode']);

    const applyCompaction = [...ctx.allEvents]
      .toReversed()
      .find((entry) => entry.type === '[wire]' && entry.event === 'context.apply_compaction');
    expect(applyCompaction).toBeDefined();
    const record = applyCompaction?.args as {
      keptUserMessageCount?: number;
      tokensAfter?: number;
      summary?: string;
      contextSummary?: string;
    };
    expect(record.keptUserMessageCount).toBe(2);
    const expectedContextSummary = `${COMPACTION_SUMMARY_PREFIX}\nCompacted summary.`;
    expect(record.summary).toBe('Compacted summary.');
    expect(record.contextSummary).toBe(expectedContextSummary);
    expect(record.tokensAfter).toBe(
      estimateTokens(expectedContextSummary) +
        estimateTokensForMessages(ctx.agent.context.history.slice(0, 2)),
    );
  });

  it('refreshes the system prompt after compaction completes', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 40);

    const refreshSpy = vi.spyOn(ctx.agent, 'refreshSystemPrompt');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reset active tools while refreshing the system prompt after compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.agent.useProfile({
      name: 'tool-profile',
      systemPrompt: () => '<profile-prompt>',
      tools: ['Read', 'Write'],
    });
    ctx.agent.tools.setActiveTools(['Read']);
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.once('compaction.completed');

    const activeTools = ctx.agent.tools
      .data()
      .filter((tool) => tool.active)
      .map((tool) => tool.name)
      .toSorted();
    expect(activeTools).toEqual(['Read']);
  });

  it('projects the compacted prefix before sending the summary request', async () => {
    const ctx = testAgent({ compactionStrategy: alwaysCompactOnce });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'empty-placeholder', turnId: '', step: 2 },
    });
    ctx.appendExchange(3, 'old user two', 'old assistant two', 40);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('context.apply_compaction', () => {
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

  // Micro compaction is disabled; this scenario is skipped because the feature
  // can no longer be enabled.
  it.skip('micro-compacts old tool results before sending the summary request', async () => {
    vi.useFakeTimers();
    enableMicroCompactionFlag();
    const ctx = testAgent({
      compactionStrategy: alwaysCompactOnce,
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
        minContextUsageRatio: 0,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.detect();
    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Summarize tool exchanges.' });
    await compacted;

    const [compactionCall] = ctx.llmCalls;
    expect(messageText(compactionCall?.history[2])).toBe('[Old tool result content cleared]');
    expect(messageText(compactionCall?.history[5])).toBe('lookup result');
  });

  it('force-refreshes OAuth credentials on compaction 401 and treats replay 401 as provider auth error', async () => {
    const records: TelemetryRecord[] = [];
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
        throw new APIStatusError(
          401,
          'Unauthorized',
          'req-compact-401',
          null,
          authKeys.length === 1 ? 'trace-compact-initial-401' : 'trace-compact-replay-401',
        );
      }
      return textResult('Recovered compacted summary.');
    };
    const ctx = testAgent({ ...oauthOptions, generate, telemetry: recordingTelemetry(records) });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const outcome = ctx.onceAny(['context.apply_compaction', 'error']);

    await ctx.rpc.beginCompaction({});

    expect(await outcome).toBe('error');
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        event: 'error',
        args: expect.objectContaining({
          code: 'provider.auth_error',
          details: expect.objectContaining({
            statusCode: 401,
            requestId: 'req-compact-401',
          }),
        }),
      }),
    );
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(
      records.find((record) => record.event === 'compaction_failed')?.properties?.['trace_id'],
    ).toBe('trace-compact-replay-401');
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'assistant', text: 'old assistant one' },
      { role: 'user', text: 'recent user two' },
      { role: 'assistant', text: 'recent assistant two' },
    ]);

    const retryOutcome = ctx.onceAny(['context.apply_compaction', 'error']);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});

    expect(await retryOutcome).toBe('context.apply_compaction');
    await completed;
    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token', 'fresh-token']);
    expect(tokenCalls).toEqual([undefined, true, undefined]);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'old user one' },
      { role: 'user', text: 'recent user two' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nRecovered compacted summary.` },
    ]);
    await ctx.expectResumeMatches();
  });

  it('fires PreCompact and PostCompact hooks from the compaction module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-compact-hooks-'));
    const hookLog = join(dir, 'hooks.jsonl');
    const hookCommand = hookPayloadLoggerCommand(hookLog);
    const ctx = testAgent({
      hookEngine: new HookEngine(
        [
          { event: 'PreCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
          { event: 'PostCompact', matcher: 'auto', command: hookCommand, timeout: 5 },
        ],
        { cwd: dir, sessionId: 'session-hooks' },
      ),
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = ctx.once('context.apply_compaction');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.agent.fullCompaction.begin({ source: 'auto', instruction: undefined });
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
      session_id: 'session-hooks',
      cwd: dir,
      trigger: 'auto',
      token_count: 39,
    });
    expect(post).toMatchObject({
      hook_event_name: 'PostCompact',
      session_id: 'session-hooks',
      cwd: dir,
      trigger: 'auto',
      estimated_token_count: ctx.agent.context.tokenCount,
    });
  });

  it('cancels while waiting for a PreCompact hook', async () => {
    let preCompactSignal: AbortSignal | undefined;
    const trigger = vi.fn(async (_event: string, args?: HookEngineTriggerArgs) => {
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
    });
    const ctx = testAgent({ hookEngine: { trigger } as unknown as HookEngine });

    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);

    ctx.agent.fullCompaction.begin({ source: 'manual', instruction: undefined });
    await vi.waitFor(() => {
      expect(preCompactSignal).toBeInstanceOf(AbortSignal);
    });
    const canceled = ctx.once('compaction.cancelled');
    ctx.agent.fullCompaction.cancel();
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
    const compacted = ctx.once('context.apply_compaction');
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

  it('strips media to text markers and retries when the summarizer request is rejected as too large', async () => {
    let attempts = 0;
    const histories: Message[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      histories.push(structuredClone(history));
      if (attempts === 1) {
        throw new APIRequestTooLargeError(413, 'Request exceeds the maximum size', 'req-413');
      }
      return textResult('Compacted without media.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    // A ReadMediaFile-shaped result: path wrapper text around inline image data.
    ctx.agent.context.appendUserMessage(
      [
        { type: 'text', text: '<image path="/workspace/shot.png">' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: '</image>' },
      ],
      { kind: 'user' },
    );
    ctx.agent.context.appendUserMessage(
      [
        { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,BBBB' } },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,CCCC' } },
      ],
      { kind: 'user' },
    );
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(attempts).toBe(2);
    // The first attempt goes out with the media as-is.
    const firstParts = histories[0]!.flatMap((message) => message.content);
    expect(firstParts.some((part) => part.type === 'image_url')).toBe(true);
    // The 413 retry replaces every media part with a text marker; the
    // ReadMediaFile path wrapper survives so the summary can still reference
    // the file, and no base64 payload leaks into the retried request.
    // (Projection may merge adjacent text parts, so assert on the joined text.)
    const retryParts = histories[1]!.flatMap((message) => message.content);
    expect(retryParts.some((part) => part.type !== 'text' && part.type !== 'think')).toBe(false);
    const retryText = retryParts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(retryText).toContain('[image]');
    expect(retryText).toContain('[video]');
    expect(retryText).toContain('[audio]');
    expect(retryText).toContain('<image path="/workspace/shot.png">');
    expect(JSON.stringify(histories[1])).not.toContain('base64');
    // Stripping is not an overflow shrink: the retry drops no messages.
    expect(histories[1]!.length).toBe(histories[0]!.length);
    // The real history is untouched: recent kept user messages retain media.
    const keptParts = ctx.agent.context.history.flatMap((message) => message.content);
    expect(keptParts.some((part) => part.type === 'image_url')).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('shrinks the history when the summarizer request stays too large after media stripping', async () => {
    let attempts = 0;
    const histories: Message[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      histories.push(structuredClone(history));
      if (attempts <= 2) {
        throw new APIRequestTooLargeError(413, 'Request exceeds the maximum size');
      }
      return textResult('Recovered after shrink.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    ctx.agent.context.appendUserMessage(
      [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }],
      { kind: 'user' },
    );
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await completed;

    expect(attempts).toBe(3);
    // Attempt 2 is the media strip: same message count, no media parts.
    expect(histories[1]!.length).toBe(histories[0]!.length);
    expect(
      histories[1]!.flatMap((m) => m.content).some((part) => part.type === 'image_url'),
    ).toBe(false);
    // Attempt 3 falls through to the overflow shrink and drops old messages.
    expect(histories[2]!.length).toBeLessThan(histories[1]!.length);
    await ctx.expectResumeMatches();
  });

  it('shrinks immediately on a too-large rejection when the history has no media', async () => {
    let attempts = 0;
    const histories: Message[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      attempts += 1;
      histories.push(structuredClone(history));
      if (attempts === 1) {
        throw new APIRequestTooLargeError(413, 'Request exceeds the maximum size');
      }
      return textResult('Recovered after shrink.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await completed;

    // With no media to strip, the too-large rejection goes straight to the
    // overflow shrink instead of wasting a retry on an identical request.
    expect(attempts).toBe(2);
    expect(histories[1]!.length).toBeLessThan(histories[0]!.length);
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
    const compacted = ctx.once('context.apply_compaction');
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
    const compacted = ctx.once('context.apply_compaction');
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
    const compacted = ctx.once('context.apply_compaction');

    await ctx.rpc.beginCompaction({});
    await firstAttemptFailed.promise;
    await vi.advanceTimersByTimeAsync(299);

    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await compacted;

    expect(attempts).toBe(2);
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

    ctx.agent.fullCompaction.cancel();
    await cancelled;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts).toBe(1);
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
    const ctx = testAgent({ generate, compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger failed auto compaction' }] });
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
    let attempts = 0;
    const generate: GenerateFn = async () => {
      attempts += 1;
      return {
        ...textResult('Partial summary.'),
        finishReason: 'truncated',
        rawFinishReason: 'length',
      };
    };
    const ctx = testAgent({ generate, compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger truncated auto compaction' }] });
    await vi.advanceTimersByTimeAsync(60_000);
    const events = await ctx.untilTurnEnd();

    // A single-item history cannot be shrunk further, so the truncated response
    // fails immediately instead of looping through retries.
    expect(attempts).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: {
          turnId: 0,
          reason: 'failed',
          error: expect.objectContaining({
            code: 'compaction.failed',
            message:
              'CompactionTruncatedError: Compaction response was truncated before producing a complete summary.',
          }),
        },
      }),
    );
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
      ctx.emitter.once('context.apply_compaction', () => {
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
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendPartiallyResolvedParallelToolExchange();
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted before open tools.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep stable facts.' });
    await compacted;
    await completed;

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "run both tools"
        assistant: []  calls call_open_one:LookupOne { "query": "one" }, call_open_two:LookupTwo { "query": "two" }
        tool[call_open_one]: text "one result"
        tool[call_open_two]: text "Tool result is not available in the current context. Do not assume the tool completed successfully."
        user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history.\\n\\n\\nOptional user instruction:\\nKeep stable facts."
    `);
    // The unresolved tool call is sent to the model with a synthetic tool_result
    // closing it (so a strict provider accepts the summary request), while the
    // whole exchange is still dropped from the replacement history, leaving only
    // the real user messages followed by the compaction summary.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_open_two',
        toolCallId: 'call_open_two',
        result: { output: 'two result' },
      },
    });
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
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
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Compacted prefix.' });
    await ctx.rpc.beginCompaction({});
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'new user while compacting' }]);
    await compacted;
    await completed;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin      { "source": "manual", "time": "<time>" }
      [emit] compaction.started         { "trigger": "manual" }
      [wire] context.append_message     { "message": { "role": "user", "content": [ { "type": "text", "text": "new user while compacting" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] llm.tools_snapshot         { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                { "kind": "compaction", "provider": "kimi", "model": "kimi-code", "modelAlias": "kimi-code", "thinkingEffort": "off", "maxTokens": 131072, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 5, "droppedCount": 0, "time": "<time>" }
      [wire] usage.record               { "model": "kimi-code", "usage": { "inputOther": 1152, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 80, "maxContextTokens": 256000, "contextUsage": 0.0003125, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1152, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1152, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction   { "summary": "Compacted prefix.", "contextSummary": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nCompacted prefix.", "compactedCount": 4, "tokensBefore": 25, "tokensAfter": 160, "keptUserMessageCount": 3, "time": "<time>" }
      [emit] agent.status.updated       { "model": "kimi-code", "contextTokens": 160, "maxContextTokens": 256000, "contextUsage": 0.000625, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1152, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1152, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete   { "time": "<time>" }
      [emit] compaction.completed       { "result": { "summary": "Compacted prefix.", "compactedCount": 4, "tokensBefore": 25, "tokensAfter": 160, "keptUserMessageCount": 3 } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history."
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


  it('cancels when the compacted prefix changes before completion', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 80);
    const canceled = ctx.once('full_compaction.cancel');

    ctx.mockNextResponse({ type: 'text', text: 'Stale summary.' });
    await ctx.rpc.beginCompaction({});
    await ctx.rpc.clearContext({});
    await canceled;

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin    { "source": "manual", "time": "<time>" }
      [emit] compaction.started       { "trigger": "manual" }
      [wire] context.clear            { "time": "<time>" }
      [emit] agent.status.updated     { "model": "kimi-code", "contextTokens": 0, "maxContextTokens": 256000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual" }
      [wire] llm.tools_snapshot       { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request              { "kind": "compaction", "provider": "kimi", "model": "kimi-code", "modelAlias": "kimi-code", "thinkingEffort": "off", "maxTokens": 131072, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 5, "droppedCount": 0, "time": "<time>" }
      [wire] usage.record             { "model": "kimi-code", "usage": { "inputOther": 1152, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated     { "model": "kimi-code", "contextTokens": 0, "maxContextTokens": 256000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1152, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1152, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.cancel   { "time": "<time>" }
      [emit] compaction.cancelled     {}
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user one"
        assistant: text "old assistant one"
        user: text "recent user two"
        assistant: text "recent assistant two"
        user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history."
    `);
    expect(ctx.compactHistory()).toMatchInlineSnapshot(`[]`);
    await ctx.expectResumeMatches();
  });

  it('blocks the turn until auto compaction finishes', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 200);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 950_000);

    ctx.mockNextResponse({ type: 'text', text: 'Auto compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer after compaction.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Answer after compacting' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "old user one" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "old user two" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "recent user three" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Answer after compacting" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Answer after compacting" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin       { "source": "auto", "time": "<time>" }
      [emit] compaction.started          { "trigger": "auto" }
      [emit] compaction.blocked          { "turnId": 0 }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "compaction", "provider": "kimi", "model": "kimi-code", "modelAlias": "kimi-code", "thinkingEffort": "off", "maxTokens": 131072, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 8, "droppedCount": 0, "time": "<time>" }
      [wire] usage.record                { "model": "kimi-code", "usage": { "inputOther": 1173, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 950000, "maxContextTokens": 256000, "contextUsage": 3.7109375, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1173, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1173, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction    { "summary": "Auto compacted summary.", "contextSummary": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nAuto compacted summary.", "compactedCount": 7, "tokensBefore": 46, "tokensAfter": 166, "keptUserMessageCount": 4, "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 166, "maxContextTokens": 256000, "contextUsage": 0.0006484375, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1173, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1173, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete    { "time": "<time>" }
      [emit] compaction.completed        { "result": { "summary": "Auto compacted summary.", "compactedCount": 7, "tokensBefore": 46, "tokensAfter": 166, "keptUserMessageCount": 4 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "kimi-code", "modelAlias": "kimi-code", "thinkingEffort": "off", "maxTokens": 255834, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I can answer after compaction." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I can answer after compaction." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 165, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 165, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "kimi-code", "usage": { "inputOther": 165, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "kimi-code", "contextTokens": 176, "maxContextTokens": 256000, "contextUsage": 0.0006875, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "kimi-code": { "inputOther": 1338, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1338, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 165, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "old user one"
          assistant: text "old assistant one"
          user: text "old user two"
          assistant: text "old assistant two"
          user: text "recent user three"
          assistant: text "recent assistant three"
          user: text "Answer after compacting"
          user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history."

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
    ctx.agent.context.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // Tool exchange is open, so the reminder is deferred — not yet in history.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with open tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the in-flight tool exchange and the deferred reminder
    // (initial context is rebuilt every turn); only real user messages and
    // the compaction summary remain.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so late tool results are orphans
    // and do not change history.
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_one',
        toolCallId: 'call_unresolved_one',
        result: { output: 'one result' },
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });

    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
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
    ctx.agent.context.appendSystemReminder('host note', {
      kind: 'injection',
      variant: 'host',
    });

    // One tool result has landed but the second is still pending — reminder defers.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted with partial tools.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    // Compaction drops the partially-resolved tool exchange and the deferred
    // reminder (initial context is rebuilt every turn); only real user
    // messages and the compaction summary remain.
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    // The dropped tool calls no longer exist, so a late tool result is an orphan
    // and does not change history.
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_unresolved_two',
        toolCallId: 'call_unresolved_two',
        result: { output: 'two result' },
      },
    });

    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
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
  });

  it('compacts a single user message and keeps it ahead of the summary', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'only pending user' }]);
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Single message summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.compactHistory()).toEqual([
      { role: 'user', text: 'only pending user' },
      { role: 'user', text: `${COMPACTION_SUMMARY_PREFIX}\nSingle message summary.` },
    ]);
    await ctx.expectResumeMatches();
  });

  it('reinjects the plan-mode reminder after manual compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.agent.planMode.enter('compact-plan', false);
    const planFilePath = ctx.agent.planMode.planFilePath;
    if (planFilePath === null) throw new Error('plan file path missing');
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'draft the plan' }]);
    await ctx.agent.injection.inject();
    expect(ctx.compactHistory().at(-1)?.text).toContain(`Plan file: ${planFilePath}`);
    const completed = ctx.once('compaction.completed');

    ctx.mockNextResponse({ type: 'text', text: 'Plan-mode compacted summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;

    await vi.waitFor(() => {
      const planReminders = ctx.agent.context.history.filter(
        (message) => message.origin?.kind === 'injection' && message.origin.variant === 'plan_mode',
      );
      expect(planReminders).toHaveLength(1);
      expect(messageText(planReminders[0])).toContain(`Plan file: ${planFilePath}`);
    });
    expect(ctx.compactHistory().at(-1)?.text).toContain(`Plan file: ${planFilePath}`);
    await ctx.expectResumeMatches();
  });

  it('includes the plan-mode reminder in the answer request after auto compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.agent.planMode.enter('auto-compact-plan', false);
    const planFilePath = ctx.agent.planMode.planFilePath;
    if (planFilePath === null) throw new Error('plan file path missing');
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    ctx.appendExchange(2, 'recent user two', 'recent assistant two', 950_000);
    await ctx.agent.injection.inject();

    ctx.mockNextResponse({ type: 'text', text: 'Auto plan compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I can answer with the plan path.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Continue the plan' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const answerTexts = ctx.llmCalls[1]?.history.map(messageText) ?? [];
    expect(answerTexts.some((text) => text.includes(`Plan file: ${planFilePath}`))).toBe(true);
    await ctx.expectResumeMatches();
  });

  it('reinjects reminders before a turn deferred during manual compaction', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    await ctx.agent.planMode.enter('deferred-plan', false);
    const planFilePath = ctx.agent.planMode.planFilePath;
    if (planFilePath === null) throw new Error('plan file path missing');
    ctx.appendExchange(1, 'old user one', 'old assistant one', 100);
    await ctx.agent.injection.inject();

    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' }); // summarizer
    ctx.mockNextResponse({ type: 'text', text: 'answer for the deferred turn' }); // deferred turn

    // A prompt arriving mid-compaction is deferred, then replayed once compaction
    // finishes. It must run AFTER reinjection, so its request carries the plan-mode
    // reminder — the post-compaction state is resurfaced on the very first turn.
    void ctx.rpc.beginCompaction({});
    expect(ctx.agent.fullCompaction.isCompacting).toBe(true);
    const turnId = ctx.agent.turn.prompt([{ type: 'text', text: 'Continue the plan' }]);
    expect(turnId).toBeNull();

    await ctx.once('compaction.completed');
    await ctx.agent.turn.waitForCurrentTurn();

    // Two generate calls: the summarizer, then the deferred turn — proving the
    // deferred prompt ran (not stuck) and saw the reinjected reminder.
    expect(ctx.llmCalls).toHaveLength(2);
    const answerTexts = ctx.llmCalls[1]?.history.map(messageText) ?? [];
    expect(answerTexts.some((text) => text.includes(`Plan file: ${planFilePath}`))).toBe(true);
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

  it('keeps an oversized pending user prompt out of auto compaction', async () => {
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
    // The auto-compact ratio is 0.85, so the context alone (840k) sits below
    // the 850k threshold and the pending prompt pushes it over.
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
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Overflow compacted summary.'),
          compactedCount: 4,
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

  it('triggers preemptive compaction against the declared input cap, not the total window', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
      if (callCount === 1) {
        return textResult('Preemptive summary under the input cap.');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Answered after input-cap compaction.' });
      return textResult('Answered after input-cap compaction.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: {
        ...CATALOGUED_MODEL_CAPABILITIES,
        max_context_tokens: 200_000,
        max_input_tokens: 150_000,
      },
    });
    // 160k sits between the input-cap trigger (150k × 0.85 = 127.5k) and the
    // total-window trigger (200k × 0.85 = 170k): compaction must fire only
    // because the input cap is the prompt budget.
    ctx.appendExchange(1, 'old user one', 'old assistant one', 160_000);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    const events = await ctx.untilTurnEnd();

    expect(callCount).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'compaction.started' }),
    );
  });

  it('honors the observed provider window over a declared input cap', async () => {
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
        max_input_tokens: 150_000,
      },
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

    // The strategy must size against the provider-learned window (~108k),
    // not the raw 150k declared input cap — otherwise it never preemptively
    // compacts the 120k context the provider already rejected.
    expect(callCount).toBe(5);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'compaction.started' }),
    );
  });

  it('stops repeated provider-overflow compactions when the compacted context still overflows', async () => {
    let callCount = 0;
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      callCount += 1;
      if (messageText(history.at(-1)).includes('first-person handoff note')) {
        return textResult(`Still too large summary ${String(callCount)}.`);
      }
      throw new APIContextOverflowError(400, 'Context length exceeded', `req-overflow-${String(callCount)}`);
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry until overflow guard' }] });
    const events = await ctx.untilTurnEnd();

    expect(countEvents(events, 'compaction.started')).toBe(3);
    expect(callCount).toBe(7);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'context.overflow',
            message: 'Compaction failed to bring the context under the model window after 3 attempts.',
          }),
        }),
      }),
    );
  });

  it('does not leave an orphan tool result at the start when reducing overflowing compaction input', async () => {
    const inputs: string[][] = [];
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      inputs.push(inputHistorySnapshot(history));
      if (inputs.length === 1) {
        throw new APIContextOverflowError(400, 'Context length exceeded', 'req-compact-overflow');
      }
      return textResult('Reduced tool history summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    ctx.appendToolExchange();
    let applyRecord: { compactedCount?: number; droppedCount?: number } | undefined;
    ctx.emitter.on('context.apply_compaction', (entry) => {
      applyRecord = (entry as { args: { compactedCount?: number; droppedCount?: number } }).args;
    });
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(inputs).toHaveLength(2);
    const reducedHistory = inputs[1]!.slice(0, -1);
    expect(reducedHistory[0]?.split(':', 1)[0]).not.toBe('tool');
    // The whole 3-message history was folded (compactedCount), and all 3 were
    // trimmed from the summarizer input on overflow (droppedCount), so the
    // record honestly reports that the summary covers none of them.
    expect(applyRecord?.compactedCount).toBe(3);
    expect(applyRecord?.droppedCount).toBe(3);
    await ctx.expectResumeMatches();
  });

  it('shrinks overflowing compaction input aggressively instead of one message at a time', async () => {
    const inputs: string[][] = [];
    let applyRecord: { compactedCount?: number; droppedCount?: number } | undefined;
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      inputs.push(inputHistorySnapshot(history));
      const compactedHistory = history.slice(0, -1);
      if (compactedHistory.length > 20) {
        throw new APIContextOverflowError(
          400,
          'Context length exceeded',
          `req-long-compact-${String(inputs.length)}`,
        );
      }
      return textResult('Aggressively reduced summary.');
    };
    const ctx = testAgent({ generate });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });
    for (let i = 0; i < 30; i++) {
      ctx.appendExchange(
        i,
        `old user ${String(i)} ${'u'.repeat(400)}`,
        `old assistant ${String(i)} ${'a'.repeat(400)}`,
        10,
      );
    }
    ctx.emitter.on('context.apply_compaction', (entry) => {
      applyRecord = (entry as { args: { compactedCount?: number; droppedCount?: number } }).args;
    });
    const compacted = ctx.once('context.apply_compaction');
    const completed = ctx.once('compaction.completed');

    await ctx.rpc.beginCompaction({});
    await compacted;
    await completed;

    expect(inputs[0]?.length).toBeGreaterThan(50);
    expect(inputs.length).toBeLessThanOrEqual(4);
    const finalCompactedHistory = inputs.at(-1)!.slice(0, -1);
    expect(finalCompactedHistory[0]?.split(':', 1)[0]).not.toBe('tool');
    expect(applyRecord?.compactedCount).toBe(60);
    expect(applyRecord?.droppedCount).toBeGreaterThan(0);
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
    expect(ctx.agent.fullCompaction.getEffectiveMaxContextTokens()).toBeLessThan(200_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'compaction.started',
        args: { trigger: 'auto' },
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
    ctx.agent.config.update({ thinkingEffort: 'high' });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with thinking preserved' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    // A Kimi model without supportEfforts is boolean-only, so the effective
    // state and every compaction request use 'on'.
    expect(providerThinkingEfforts).toEqual(['on', 'on', 'on']);
    expect(records).toContainEqual({
      event: 'compaction_finished',
      properties: expect.objectContaining({
        source: 'auto',
        thinking_effort: 'on',
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
    const providerManager = ctx.agent.modelProvider;
    if (providerManager === undefined) throw new Error('Expected provider manager');
    const resolveProviderConfig = providerManager.resolveProviderConfig.bind(providerManager);
    providerManager.resolveProviderConfig = (model) => ({
      ...resolveProviderConfig(model),
      modelCapabilities: UNKNOWN_CAPABILITY,
    });
    expect(ctx.agent.config.modelCapabilities.max_context_tokens).toBe(0);
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
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Unknown window compacted summary.'),
          compactedCount: 4,
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

  it('honors completion budget env opt-out during compaction', async () => {
    vi.stubEnv('KIMI_MODEL_MAX_COMPLETION_TOKENS', '0');
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
  });

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
    // Set maxOutputSize on the harness's internal kimiConfig — the
    // compaction path reads it via ConfigState.maxOutputSize.
    const models = (ctx as unknown as { kimiConfig: KimiConfig }).kimiConfig.models;
    models![CATALOGUED_PROVIDER.model] = {
      ...models![CATALOGUED_PROVIDER.model]!,
      maxOutputSize: 384000,
    };
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry with max output' }] });
    await ctx.untilTurnEnd();

    expect(callCount).toBe(3);
    expect(compactionMaxCompletionTokens).toEqual([384000]);
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
    const generate: GenerateFn = async (_provider, _system, _tools, _history, callbacks) => {
      callCount += 1;
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
      compactionStrategy: overflowOnlyCompactionStrategy(),
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
        event: 'context.apply_compaction',
        args: expect.objectContaining({
          summary: expect.stringContaining('Placeholder compacted summary.'),
          compactedCount: 4,
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

  it('emits context.overflow and terminates the turn after too many auto compactions', async () => {
    const ctx = testAgent({ compactionStrategy: alwaysCompactOnce });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'First compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'I need a tool.' }, missingToolCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger repeated compaction' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Trigger repeated compaction" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Trigger repeated compaction" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] full_compaction.begin       { "source": "auto", "time": "<time>" }
      [emit] compaction.started          { "trigger": "auto" }
      [emit] compaction.blocked          { "turnId": 0 }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "compaction", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 131072, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 2, "droppedCount": 0, "time": "<time>" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 1135, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "session", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 1135, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1135, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.apply_compaction    { "summary": "First compacted summary.", "contextSummary": "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nFirst compacted summary.", "compactedCount": 1, "tokensBefore": 8, "tokensAfter": 153, "keptUserMessageCount": 1, "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 153, "maxContextTokens": 1000000, "contextUsage": 0.000153, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 1135, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1135, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] full_compaction.complete    { "time": "<time>" }
      [emit] compaction.completed        { "result": { "summary": "First compacted summary.", "compactedCount": 1, "tokensBefore": 8, "tokensAfter": 153, "keptUserMessageCount": 1 } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999847, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I need a tool." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_missing", "name": "MissingTool", "argumentsPart": "{}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I need a tool." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_missing", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_missing", "name": "MissingTool", "args": {} }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_missing", "name": "MissingTool", "args": {} }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_missing", "toolCallId": "call_missing", "result": { "output": "Tool \\"MissingTool\\" not found", "isError": true } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_missing", "output": "Tool \\"MissingTool\\" not found", "isError": true }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 154, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 154, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 154, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 165, "maxContextTokens": 1000000, "contextUsage": 0.000165, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 1289, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1289, "output": 20, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 154, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 2, "reason": "error", "message": "Compaction limit exceeded (1)" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "context.overflow", "message": "Compaction limit exceeded (1)", "name": "KimiError", "details": { "maxCompactions": 1, "turnId": 0 }, "retryable": true } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "context.overflow", "message": "Compaction limit exceeded (1)", "name": "KimiError", "details": { "maxCompactions": 1, "turnId": 0 }, "retryable": true }`,
    );
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Trigger repeated compaction"
          user: text "You are about to run out of context. Write a first-person handoff note to\\nyourself so you can seamlessly continue this task after the earlier\\nconversation is cleared.\\n\\n--- This message is a direct task, not part of the above conversation ---\\n\\nWrite the note as your own continuing train of thought — first person, present\\ntense, the way you would reason through the next move. Do not write a\\nthird-party report about someone else's work, and do not impose rigid section\\nheadings; let the shape follow the task. Write the note in the same language the\\nconversation has been using — do not switch to English just because these\\ninstructions happen to be in English.\\n\\nMake the note self-sufficient: the next turn will see only your most recent user\\nmessages and this note — every assistant message, tool call, and tool result\\nabove will be gone. In your own words, preserve what you genuinely need to\\ncontinue:\\n\\n- What the latest request is actually asking for: your reading of its intent and\\n  any ambiguity you have already resolved — not a re-transcription, since what\\n  fits is kept verbatim in your most recent messages. But those kept messages are\\n  size-capped, so a long request is truncated there: if the latest request is\\n  large (a big paste or file), preserve the parts at risk of being dropped —\\n  above all the actual ask. If several requests are in play, say which one governs\\n  the next move, and re-quote any still-relevant earlier request that may have\\n  scrolled out of the kept messages.\\n- The instructions and constraints currently in force (user preferences,\\n  project rules, environment and tooling limits) — condensed to what still\\n  matters, keeping decisions you have already settled (what you chose and why)\\n  separate from questions still open, so you neither silently reopen a closed\\n  choice nor treat an undecided point as decided.\\n- What has actually been done, at high fidelity: keep the exact commands that\\n  were run, the exact file paths touched, and whether each succeeded or failed —\\n  and the results themselves, not just the commands: the concrete values\\n  returned, the key lines or error text, the schema or signature a lookup\\n  revealed, since re-running to recover them may be slow or impossible. Keep only\\n  the final working version of any code; drop intermediate attempts and\\n  already-resolved errors.\\n- What you still don't know: context the next step depends on that this\\n  conversation never established — files or paths referenced but not yet read,\\n  schemas or APIs assumed but unseen, questions the user has not answered. Name\\n  these gaps so the next turn goes and checks them instead of assuming.\\n- The forward plan — and this is the moment to invest in it. Right now you\\n  hold more context on this task than you ever will again; the next turn\\n  resumes with less, so the plan you commit here is the one it will follow.\\n  Give the exact next command or tool call, but don't stop at the next step:\\n  set out the remaining sequence to finish, the decisions you have already\\n  made for those upcoming steps (so the next turn doesn't reopen them), the\\n  obstacles or edge cases you can already foresee and how you mean to handle\\n  them, and any work you can commit to now — the exact patch, query, or shape\\n  of the final answer you already know you will produce. Anything you settle\\n  here is one less thing the next turn must rediscover. Include any required\\n  format for the final answer.\\n\\nYour TODO list is re-attached automatically below this note from its live\\nsource, so do not transcribe it — copying it wastes space and can contradict the\\nlive version. What that list cannot hold is the reasoning between tasks — why one\\nwas reordered or dropped, or a decision on one that constrains another — so\\nrecord that instead.\\n\\nBe honest about uncertainty. If an earlier step claimed something was done but\\nwas never verified (tests \\"passing\\", a fix \\"working\\", a file \\"created\\"), say so\\nplainly and treat it as unverified rather than fact — re-check before relying\\non it.\\n\\nBe concise, and keep the note proportional to the task: a long multi-step task\\nwarrants detail, but a trivial or nearly finished exchange needs only a sentence\\nor two — do not pad it out. Include the critical data, identifiers, and\\nreferences needed to continue, and omit anything that does not change the next\\nmove.\\n\\nRespond with text only. Do not call any tools — you already have everything you\\nneed in the conversation history."

      call 2:
        messages:
          user: text "Trigger repeated compaction"
          user: text "The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over. Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it. Any user messages earlier in this context are preserved verbatim from the compacted conversation; where a system-reminder note among them marks an omitted middle section, the user messages it replaced are covered by this summary.\\nFirst compacted summary."
    `);
    await ctx.expectResumeMatches();
  });

});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function enableMicroCompactionFlag(): void {
  vi.stubEnv(MASTER_ENV, '0');
  vi.stubEnv(MICRO_COMPACTION_FLAG_ENV, '1');
}

function getMicroCompactionFlagEnv(): string {
  // Micro compaction is disabled and its flag has been removed from the registry;
  // the env var name is kept so the (skipped) test still type-checks.
  return 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION';
}

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

function oauthTestAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
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
        },
      },
    },
    providerManagerOverrides: {
      resolveOAuthTokenProvider: () => ({ getAccessToken }),
    },
  };
}

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

const alwaysCompactOnce: CompactionStrategy = {
  shouldCompact: () => true,
  shouldBlock: () => true,
  checkAfterStep: true,
  maxCompactionPerTurn: 1,
  maxOverflowCompactionAttempts: 3,
};

function missingToolCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_missing',
    name: 'MissingTool',
    arguments: '{}',
  };
}

function overflowOnlyCompactionStrategy(maxSize: number = 14): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => maxSize, {
    triggerRatio: Infinity,
    blockRatio: Infinity,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
  });
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function messageText(message: Message | undefined): string {
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

function hookPayloadLoggerCommand(logPath: string): string {
  // Write the hook script to a file and run it with node, instead of
  // `node -e <json>` — cmd.exe on Windows mangles the escaped quotes in the
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
