import type { Message } from '#/kosong/contract/message';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokens, estimateTokensForMessages } from '#/kosong/contract/tokens';
import { buildImageCompressionCaption } from '#/agent/media/image-compress';
import {
  buildContextCompactionShape,
  COMPACT_USER_MESSAGE_HEAD_TOKENS,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  selectCompactionUserMessages,
  type TokenEstimate,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IWireService } from '#/wire/wire';
import {
  IAgentContextMemoryService,
  IAgentTokenCountingService,
  IAgentProfileService,
} from '#/index';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('Agent context', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tokenCounting: IAgentTokenCountingService;
  let profile: IAgentProfileService;
  let wire: IWireService;

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    tokenCounting = ctx.get(IAgentTokenCountingService);
    profile = ctx.get(IAgentProfileService);
    wire = ctx.get(IWireService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('stores prompt origins without leaking them to LLM projection', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.appendSystemReminder('Remember this.', { kind: 'injection', variant: 'host' });
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_origin', name: 'Run', arguments: '{}' }],
      },
    );
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCalls: [],
        toolCallId: 'call_origin',
      },
    );

    expect(context.get().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
      { role: 'assistant', origin: undefined },
      { role: 'tool', origin: undefined },
    ]);
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_error', name: 'Run', arguments: '{}' },
          { type: 'function', id: 'call_empty', name: 'Run', arguments: '{}' },
        ],
      },
    );
    context.append(
      {
        role: 'tool',
        content: [
          {
            type: 'text',
            text: '<system>ERROR: Tool execution failed.</system>\npermission denied',
          },
        ],
        toolCalls: [],
        toolCallId: 'call_error',
      },
    );
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    );

    expect(ctx.project()).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call_error' }, { id: 'call_empty' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'text',
            text: '<system>ERROR: Tool execution failed.</system>\npermission denied',
          },
        ],
        toolCallId: 'call_error',
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCallId: 'call_empty',
      },
    ]);
  });

  it('drops empty text parts only in LLM projection', () => {
    const history: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Run the tool' },
        ],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'enc_empty_thinking' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '   ' }],
        toolCalls: [],
      },
    ];

    expect(ctx.project(history)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Run the tool' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'enc_empty_thinking' }],
        toolCalls: [],
      },
    ]);
    expect(history[0]?.content).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Run the tool' },
    ]);
    expect(history[1]?.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('renders tool result messages left empty by LLM projection cleanup as empty output', () => {
    const history: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '' }],
        toolCallId: 'call_empty',
        toolCalls: [],
      },
    ];

    expect(ctx.project(history)).toEqual([
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    ]);
  });

  it('projects hook result messages into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hooked input' }]);
    context.append(
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
    );
    context.append(
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    );
    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue from stop hook' }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'Stop' },
      },
    );

    expect(context.get()).toHaveLength(4);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue from stop hook' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects blocked UserPromptSubmit prompts into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'blocked prompt' }]);
    context.append(
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    );
    ctx.appendUserMessage([{ type: 'text', text: 'safe followup' }]);

    expect(context.get()).toHaveLength(3);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'blocked prompt' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
          },
        ],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'safe followup' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects user, assistant, tool call, and tool result records into LLM history', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendAssistantText(1, 'earlier assistant');
    ctx.appendToolExchange();

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "user before step 1"
        assistant: text "earlier assistant"
        user: text "lookup something"
        assistant: text "I will call Lookup."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "lookup result"
        user: text "continue"
    `);
  });

  it('keeps system reminders separate from real user prompts', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendSystemReminder('Remember the host note.', {
      kind: 'injection',
      variant: 'host',
    });

    ctx.mockNextResponse({ type: 'text', text: 'noted' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Real user prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "<system-reminder>\\nRemember the host note.\\n</system-reminder>"
        user: text "Real user prompt"
    `);
  });

  it('defers system reminders until pending tool results are recorded and resumed', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'load a skill' }]);
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_write', name: 'Write', arguments: '{}' },
          { type: 'function', id: 'call_skill', name: 'Skill', arguments: '{}' },
        ],
      },
    );
    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act_skill',
          skillName: 'demo',
          trigger: 'model-tool',
        },
      },
    );

    expect(context.get().map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'wrote file' }],
        toolCalls: [],
        toolCallId: 'call_write',
      },
    );
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'skill loaded' }],
        toolCalls: [],
        toolCallId: 'call_skill',
      },
    );

    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.project()[4]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' },
    ]);
  });

  it('clears context before the next LLM request', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendUserMessage([{ type: 'text', text: 'stale user message' }]);
    await ctx.rpc.clearContext({});

    ctx.mockNextResponse({ type: 'text', text: 'fresh' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'fresh prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "fresh prompt"
    `);
  });

  it('includes new user messages as pending until the next usage update', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next user prompt'.repeat(20) }]);

    const pendingMessages = context.get().slice(-1);
    expect(tokenCounting.get().size).toBe(
      tokenCounting.get().measured + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps tool results pending when step usage covers only through the assistant message', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'lookup pending tokens' }]);
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_pending_tokens', name: 'Lookup', arguments: '{}' },
        ],
      },
    );
    tokenCounting.measured(context.get(), [], {
      inputCacheRead: 0,
      inputCacheCreation: 0,
      inputOther: 1_280,
      output: 0,
    });
    context.append(
      {
        role: 'tool',
        content: [{ type: 'text', text: 'large tool result '.repeat(50) }],
        toolCalls: [],
        toolCallId: 'call_pending_tokens',
      },
    );

    const pendingMessages = context.get().slice(-1);
    expect(tokenCounting.get().measured).toBe(1_280);
    expect(tokenCounting.get().size).toBe(
      1_280 + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps zero-usage steps pending instead of zeroing tokenCount', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next prompt' }]);

    expect(tokenCounting.get().measured).toBe(1_000);
    expect(tokenCounting.get().size).toBeGreaterThanOrEqual(
      tokenCounting.get().measured,
    );
  });

  it('get(start, end) returns the size of a context-message range', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });

    ctx.appendUserMessage([{ type: 'text', text: 'pending one'.repeat(20) }]);
    ctx.appendUserMessage([{ type: 'text', text: 'pending two'.repeat(20) }]);

    const messages = context.get();
    const tailEstimate = estimateTokensForMessages(messages.slice(2));

    expect(tokenCounting.get()).toEqual({
      size: 1_000 + tailEstimate,
      measured: 1_000,
      estimated: tailEstimate,
    });

    const firstPending = estimateTokensForMessages(messages.slice(2, 3));
    expect(tokenCounting.get(2, 3)).toEqual({
      size: firstPending,
      measured: 0,
      estimated: firstPending,
    });

    expect(tokenCounting.get(0, 2)).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });

    const prefixHead = estimateTokensForMessages(messages.slice(0, 1));
    expect(tokenCounting.get(0, 1)).toEqual({
      size: prefixHead,
      measured: prefixHead,
      estimated: 0,
    });

    const assistant = estimateTokensForMessages(messages.slice(1, 2));
    expect(tokenCounting.get(1, 3)).toEqual({
      size: assistant + firstPending,
      measured: assistant,
      estimated: firstPending,
    });

    expect(tokenCounting.get(-2)).toEqual({
      size: tailEstimate,
      measured: 0,
      estimated: tailEstimate,
    });
    expect(tokenCounting.get(0, -2)).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
    expect(tokenCounting.get(-3, -1)).toEqual({
      size: assistant + firstPending,
      measured: assistant,
      estimated: firstPending,
    });

    expect(tokenCounting.get(-1, -3)).toEqual({ size: 0, measured: 0, estimated: 0 });
  });

  it('resets the measured context size when the context is cleared', () => {
    ctx.appendAssistantTextWithUsage(1, 'answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    context.clear();

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
  });

  it('restores the real measured anchor when undo truncates the ledger', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2', 2_000);
    expect(tokenCounting.get().measured).toBe(2_000);

    await ctx.undoHistory(1);

    const surviving = context.get();
    expect(surviving.map((m) => m.role)).toEqual(['user', 'assistant']);
    // The first exchange's anchor survives the cut, so the prefix reads its
    // REAL measured size instead of a re-estimate.
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('keeps the measured prefix when undo removes only the unmeasured tail', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2');
    expect(tokenCounting.get().measured).toBe(1_000);

    await ctx.undoHistory(1);

    expect(context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('undo only counts real user prompts, skipping task notifications', async () => {
    ctx.appendTurnExchange('u1', 'first response');
    ctx.appendTurnExchange('u2', 'second response');

    context.append(
      {
        role: 'user',
        content: [{ type: 'text', text: 'background task completed' }],
        toolCalls: [],
        origin: {
          kind: 'task',
          taskId: 'bash-001',
          status: 'completed',
          notificationId: 'task:bash-001:completed',
        },
      },
    );

    expect(context.get().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    await ctx.undoHistory(1);

    expect(context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('removes injection messages inside the undone turn', async () => {
    ctx.appendUserTurn('earlier question');
    ctx.appendUserTurn('do the work');
    context.append(
      userMessage('Plan mode is active', {
        kind: 'injection',
        variant: 'plan_mode',
      }),
    );
    context.append(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'work done' }],
        toolCalls: [],
        origin: undefined,
      },
    );

    await ctx.undoHistory(1);

    expect(context.get()).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'earlier question' }],
        origin: { kind: 'user' },
      }),
    ]);
  });

  it('removes a pre-anchor image compression reminder when undoing its prompt', async () => {
    profile.update({ activeToolNames: [] });
    const caption = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: `inspect this image ${caption}` }],
    });
    await ctx.untilTurnEnd();

    expect(context.get()).toMatchObject([
      { origin: { kind: 'injection', variant: 'image_compression' } },
      { origin: { kind: 'user' } },
      { role: 'assistant' },
    ]);

    await ctx.undoHistory(1);

    expect(context.get()).toEqual([]);
  });

  describe('notification projection', () => {
    it('does not merge a cron-fire envelope into an adjacent user message', () => {
      const cronEnvelope =
        '<cron-fire jobId="deadbeef" cron="*/5 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>';
      const messages = ctx.project([
        userMessage(cronEnvelope, {
          kind: 'cron_job',
          jobId: 'deadbeef',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        }),
        userMessage('Actual follow-up from the user', { kind: 'user' }),
      ]);
      expect(messages).toHaveLength(2);
      expect(textOf(messages[0]!)).toBe(cronEnvelope);
      expect(textOf(messages[1]!)).toBe('Actual follow-up from the user');
    });

    it('uses message origin to keep non-user-origin messages separate', () => {
      const messages = ctx.project([
        userMessage('Host reminder without an XML prefix', {
          kind: 'injection',
          variant: 'host',
        }),
        userMessage('Actual follow-up from the user', { kind: 'user' }),
      ]);

      expect(messages).toHaveLength(2);
      expect(textOf(messages[0]!)).toBe('Host reminder without an XML prefix');
      expect(textOf(messages[1]!)).toBe('Actual follow-up from the user');
    });

    it('only merges user-role messages with user origin', () => {
      const messages = ctx.project([
        userMessage('First real prompt', { kind: 'user' }),
        userMessage('Second real prompt', { kind: 'user' }),
        userMessage('No origin prompt'),
        userMessage('Third real prompt', { kind: 'user' }),
      ]);

      expect(messages).toHaveLength(3);
      expect(textOf(messages[0]!)).toBe('First real prompt\n\nSecond real prompt');
      expect(textOf(messages[1]!)).toBe('No origin prompt');
      expect(textOf(messages[2]!)).toBe('Third real prompt');
    });
  });

  describe('compaction handoff under a zero estimator', () => {
    const zero: TokenEstimate = { text: () => 0, message: () => 0, messages: () => 0 };

    it('keeps every user message without elision', () => {
      const messages = Array.from({ length: 300 }, (_, i) =>
        userMessage(`user ${i} ${'x'.repeat(400)}`),
      );

      const zeroed = selectCompactionUserMessages(
        messages,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        COMPACT_USER_MESSAGE_HEAD_TOKENS,
        zero.message,
      );
      expect(zeroed.elided).toBe(false);
      expect(zeroed.head).toHaveLength(0);
      expect(zeroed.tail).toHaveLength(messages.length);

      // Sanity: the default estimator elides this much user text.
      expect(selectCompactionUserMessages(messages).elided).toBe(true);
    });

    it('falls back to a zero tokensAfter', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const shape = buildContextCompactionShape(
        history,
        { summary: 'summary', compactedCount: 2, tokensBefore: 0 },
        zero,
      );

      expect(shape.tokensAfter).toBe(0);
      expect(shape.messages.map((m) => m.role)).toEqual(['user', 'user']);
      expect(shape.messages[1]?.origin?.kind).toBe('compaction_summary');
    });

    it('prefers the measured summary output tokens over the text estimate', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const withMeasured = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
      });
      const withEstimate = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
      });

      expect(withMeasured.tokensAfter).toBeGreaterThan(500);
      // Same kept messages; only the summary component differs — the
      // measured 500 replaces the summary-text estimate.
      expect(withMeasured.tokensAfter - 500).toBe(
        withEstimate.tokensAfter - estimateTokens('summary'),
      );
      expect(withMeasured.messages).toEqual(withEstimate.messages);
    });

    it('counts the request overhead into tokensAfter on the full-request basis', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        toolCalls: [],
      } as ContextMessage];

      const withOverhead = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
        requestOverheadTokens: 3_000,
      });
      const withoutOverhead = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
        summaryOutputTokens: 500,
      });

      expect(withOverhead.tokensAfter).toBe(withoutOverhead.tokensAfter + 3_000);
      expect(withOverhead.messages).toEqual(withoutOverhead.messages);
    });
  });
});

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function textOf(message: Message): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
