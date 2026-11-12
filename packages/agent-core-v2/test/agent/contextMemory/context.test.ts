import type { Message, ToolCall } from '#human/llm/message';
import { appendContext } from './stubs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateTokens, estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import { buildImageCompressionCaption } from '#/agent/media/image-compress';
import {
  buildContextCompactionShape,
  COMPACT_USER_MESSAGE_HEAD_TOKENS,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  selectCompactionUserMessages,
  selectRecentUserMessages,
  type TokenEstimate,
} from '#/agent/contextMemory/compactionHandoff';
import { type ContextMessage } from '#/agent/contextMemory/types';
import {
  closeTrailingOpenToolExchange,
  INHERITED_IN_FLIGHT_TOOL_OUTPUT,
} from '#/agent/contextMemory/openToolExchange';
import { IWireService } from '#/wire/wire';
import { IAgentLoopService } from '#/index';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('Agent context', () => {
  let ctx: TestAgentContext;
  let context: IAgentLoopService;
  let tokenCounting: TestAgentContext['tokenCounting'];
  let profile: IAgentLoopService;
  let wire: IWireService;

  beforeEach(async () => {
    ctx = createTestAgent();
    context = ctx.get(IAgentLoopService);
    tokenCounting = ctx.tokenCounting;
    profile = ctx.get(IAgentLoopService);
    wire = ctx.get(IWireService);
    await ctx.restorePersisted();
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
    appendContext(context,
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_origin', name: 'Run', arguments: '{}' }],
      },
    );
    appendContext(context,
      {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCallId: 'call_origin',
      },
    );

    expect(context.history().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
      { role: 'assistant', origin: undefined },
      { role: 'tool', origin: undefined },
    ]);
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    appendContext(context,
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_error', name: 'Run', arguments: '{}' },
          { type: 'function', id: 'call_empty', name: 'Run', arguments: '{}' },
        ],
      },
    );
    appendContext(context,
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
    );
    appendContext(context,
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
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
      },
    ];

    expect(ctx.project(history)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Run the tool' }],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_empty', name: 'empty', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
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
        toolCallId: 'call_empty',
      },
    ]);
  });

  it('projects hook result messages into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hooked input' }]);
    appendContext(context,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
    );
    appendContext(context,
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
    appendContext(context,
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue from stop hook' }],
        origin: { kind: 'hook_result', event: 'Stop' },
      },
    );

    expect(context.history()).toHaveLength(4);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
          },
        ],
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
      },
    ]);
  });

  it('projects blocked UserPromptSubmit prompts into LLM projection', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'blocked prompt' }]);
    appendContext(context,
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

    expect(context.history()).toHaveLength(3);
    expect(ctx.project()).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'blocked prompt' }],
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
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
      messages:
        user: text "user before step 1"
        assistant: text "earlier assistant"
        user: text "lookup something"
        assistant: text "I will call Lookup."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "lookup result"
        user: text "continue"
    `);
  });

  it('keeps reminder history separate from real user prompts', async () => {
    profile.update({ activeToolNames: [] });
    ctx.appendSystemReminder('Remember the previous environment.', {
      kind: 'injection',
      variant: 'environment_binding',
    });
    ctx.appendSystemReminder('Remember the current environment.', {
      kind: 'injection',
      variant: 'environment_binding',
    });

    ctx.mockNextResponse({ type: 'text', text: 'noted' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Real user prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
      messages:
        user: text "<system-reminder>\\nRemember the previous environment.\\n</system-reminder>"
        user: text "<system-reminder>\\nRemember the current environment.\\n</system-reminder>"
        user: text "Real user prompt"
    `);
  });

  it('defers system reminders until pending tool results are recorded and resumed', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'load a skill' }]);
    appendContext(context,
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_write', name: 'Write', arguments: '{}' },
          { type: 'function', id: 'call_skill', name: 'Skill', arguments: '{}' },
        ],
      },
    );
    appendContext(context,
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' }],
        origin: {
          kind: 'skill_activation',
          activationId: 'act_skill',
          skillName: 'demo',
          trigger: 'model-tool',
        },
      },
    );

    expect(context.history().map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    appendContext(context,
      {
        role: 'tool',
        content: [{ type: 'text', text: 'wrote file' }],
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

    appendContext(context,
      {
        role: 'tool',
        content: [{ type: 'text', text: 'skill loaded' }],
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
    const dispatched = vi.spyOn(ctx.dispatcher, 'dispatch');
    try {
      await ctx.rpc.clearContext({});
      expect(context.history()).toEqual([]);
      expect(tokenCounting.get()).toMatchObject({ size: 0, measured: 0 });
      expect(dispatched.mock.calls.map(([event]) => event.type)).toEqual([
        'context.clear',
        'token_counting.rebased',
        'context.spliced',
      ]);
    } finally {
      dispatched.mockRestore();
    }
    await ctx.expectResumeMatches();

    ctx.mockNextResponse({ type: 'text', text: 'fresh' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'fresh prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
      messages:
        user: text "fresh prompt"
    `);
  });

  it('includes new user messages as pending until the next usage update', () => {
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next user prompt'.repeat(20) }]);

    const pendingMessages = context.history().slice(-1);
    expect(tokenCounting.get().size).toBe(
      tokenCounting.get().measured + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps tool results pending when step usage covers only through the assistant message', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'lookup pending tokens' }]);
    appendContext(context,
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_pending_tokens', name: 'Lookup', arguments: '{}' },
        ],
      },
    );
    tokenCounting.measured(context.history(), [], {
      inputCacheRead: 0,
      inputCacheCreation: 0,
      inputOther: 1_280,
      output: 0,
    });
    appendContext(context,
      {
        role: 'tool',
        content: [{ type: 'text', text: 'large tool result '.repeat(50) }],
        toolCallId: 'call_pending_tokens',
      },
    );

    const pendingMessages = context.history().slice(-1);
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

    const messages = context.history();
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

    context.replaceHistory([], 'clear');

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
  });

  it('restores the real measured anchor when undo truncates the ledger', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2', 2_000);
    expect(tokenCounting.get().measured).toBe(2_000);

    await ctx.undoHistory(1);

    const surviving = context.history();
    expect(surviving.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('keeps the measured prefix when undo removes only the unmeasured tail', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2');
    expect(tokenCounting.get().measured).toBe(1_000);

    await ctx.undoHistory(1);

    expect(context.history().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
  });

  it('undo only counts real user prompts, skipping task notifications', async () => {
    ctx.appendTurnExchange('u1', 'first response');
    ctx.appendTurnExchange('u2', 'second response');

    appendContext(context,
      {
        role: 'user',
        content: [{ type: 'text', text: 'background task completed' }],
        origin: {
          kind: 'task',
          taskId: 'bash-001',
          status: 'completed',
          notificationId: 'task:bash-001:completed',
        },
      },
    );

    expect(context.history().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    await ctx.undoHistory(1);

    expect(context.history().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps un-owned injection messages from the undone turn in the rebuilt context', async () => {
    ctx.appendUserTurn('earlier question');
    ctx.appendUserTurn('do the work');
    appendContext(context,
      userMessage('Plan mode is active', {
        kind: 'injection',
        variant: 'plan_mode',
      }),
    );
    appendContext(context,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'work done' }],
        toolCalls: [],
        origin: undefined,
      },
    );

    await ctx.undoHistory(1);

    expect(context.history()).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'earlier question' }],
        origin: { kind: 'user' },
      }),
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Plan mode is active' }],
        origin: { kind: 'injection', variant: 'plan_mode' },
      }),
    ]);
  });

  it('keeps the image compression caption inline and removes it with its prompt on undo', async () => {
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

    expect(context.history()).toMatchObject([
      {
        origin: { kind: 'user' },
        id: expect.any(String),
        content: [{ type: 'text', text: `inspect this image ${caption}` }],
      },
      { role: 'assistant' },
    ]);

    await ctx.undoHistory(1);

    expect(context.history()).toEqual([]);
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

    it('keeps every user-role message separate', () => {
      const messages = ctx.project([
        userMessage('First real prompt', { kind: 'user' }),
        userMessage('Second real prompt', { kind: 'user' }),
        userMessage('No origin prompt'),
        userMessage('Third real prompt', { kind: 'user' }),
      ]);

      expect(messages).toHaveLength(4);
      expect(textOf(messages[0]!)).toBe('First real prompt');
      expect(textOf(messages[1]!)).toBe('Second real prompt');
      expect(textOf(messages[2]!)).toBe('No origin prompt');
      expect(textOf(messages[3]!)).toBe('Third real prompt');
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

      expect(selectCompactionUserMessages(messages).elided).toBe(true);

      const hooked: ContextMessage = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\nhook note\n</hook_result>',
            meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
          },
          { type: 'text', text: 'x'.repeat(4000) },
        ],
      };
      const truncated = selectRecentUserMessages([hooked], 10);
      expect(truncated[0]?.content[0]).toMatchObject({
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nhook note\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      });
      expect(truncated[0]?.content).toHaveLength(2);
    });

    it('falls back to a zero tokensAfter', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
      } as ContextMessage];

      const shape = buildContextCompactionShape(
        history,
        { summary: 'summary', compactedCount: 2, tokensBefore: 0 },
        zero,
      );

      expect(shape.tokensAfter).toBe(0);
      expect(shape.messages.map((m) => m.role)).toEqual(['user', 'user', 'user']);
      expect(shape.messages[1]?.origin?.kind).toBe('compaction_summary');
      expect(shape.messages[2]?.origin).toEqual({ kind: 'injection', variant: 'compaction_continuation' });
    });

    it('prefers the measured summary output tokens over the text estimate', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
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
      expect(withMeasured.tokensAfter - 500).toBe(
        withEstimate.tokensAfter - estimateTokens('summary'),
      );
      expect(withMeasured.messages).toEqual(withEstimate.messages);
    });

    it('counts the request overhead into tokensAfter on the full-request basis', () => {
      const history = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
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

    it('keeps injections appended after the compacted prefix and drops those inside it', () => {
      const history = [
        userMessage('u1'),
        userMessage('old reminder', { kind: 'injection', variant: 'host' }),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a1' }],
        } as ContextMessage,
        userMessage('new reminder', { kind: 'injection', variant: 'tool_update_pending' }),
        userMessage('new user'),
      ];

      const shape = buildContextCompactionShape(history, {
        summary: 'summary',
        compactedCount: 3,
        tokensBefore: 0,
      });

      expect(shape.messages).toHaveLength(5);
      expect(textOf(shape.messages[0]!)).toBe('u1');
      expect(textOf(shape.messages[1]!)).toBe('new user');
      expect(shape.messages[2]?.origin?.kind).toBe('compaction_summary');
      expect(shape.messages[3]?.origin).toEqual({
        kind: 'injection',
        variant: 'compaction_continuation',
      });
      expect(shape.messages[4]).toBe(history[3]);
      expect(shape.messages.map(textOf)).not.toContain('old reminder');
      expect(shape.appendedInjectionCount).toBe(1);
    });

    it('counts injections appended after the compacted prefix into tokensAfter', () => {
      const base = [userMessage('u1'), {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
      } as ContextMessage];
      const appended = userMessage('new reminder', { kind: 'injection', variant: 'host' });

      const without = buildContextCompactionShape(base, {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
      });
      const withInjection = buildContextCompactionShape([...base, appended], {
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 0,
      });

      expect(withInjection.tokensAfter).toBe(
        without.tokensAfter + estimateTokensForMessages([appended]),
      );
    });
  });

  it('preserves surrogate pairs when truncating from the end', () => {
    const suffix = (maxTokens: number) =>
      selectCompactionUserMessages([userMessage('x😀')], maxTokens, 0, () => 100).tail[0]?.content[0];

    expect(suffix(1)).toMatchObject({ type: 'text', text: '😀' });
    expect(suffix(2)).toMatchObject({ type: 'text', text: 'x😀' });
  });

  describe('legacy compaction layout', () => {
    it('keeps the verbatim summary followed by the uncompacted tail', () => {
      const history = [userMessage('old'), userMessage('tail')];
      const legacySummary: ContextMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'legacy summary' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      };
      const input = {
        summary: 'legacy summary',
        legacySummaryMessage: legacySummary,
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        legacyTail: true,
      };

      const shape = buildContextCompactionShape(history, input);

      expect(shape.messages[0]).toBe(legacySummary);
      expect(shape.messages[1]).toBe(history[1]);
      expect(shape.messages.map(textOf)).toEqual(['legacy summary', 'tail']);
    });
  });
});

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    origin,
  };
}

function textOf(message: Message): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('closeTrailingOpenToolExchange', () => {
  const user: ContextMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
  };
  const readCall: ToolCall = { type: 'function', id: 'call_read', name: 'Read', arguments: '{}' };
  const agentCall: ToolCall = { type: 'function', id: 'call_agent', name: 'Agent', arguments: '{}' };

  it('returns an empty seed for an empty history', () => {
    expect(closeTrailingOpenToolExchange([])).toEqual([]);
  });

  it('keeps a history without tool calls unchanged', () => {
    const history = [user];
    expect(closeTrailingOpenToolExchange(history)).toEqual(history);
  });

  it('keeps a fully answered trailing exchange unchanged', () => {
    const history: ContextMessage[] = [
      user,
      { role: 'assistant', content: [], toolCalls: [readCall] },
      {
        role: 'tool',
        toolCallId: 'call_read',
        content: [{ type: 'text', text: 'contents' }],
      },
    ];
    expect(closeTrailingOpenToolExchange(history)).toEqual(history);
  });

  it('closes an unanswered trailing call with a synthetic in-flight result', () => {
    const assistant: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'delegating the follow-up' }],
      toolCalls: [agentCall],
    };
    const seed = closeTrailingOpenToolExchange([user, assistant]);

    expect(seed).toHaveLength(3);
    expect(seed.slice(0, 2)).toEqual([user, assistant]);
    expect(seed[2]).toEqual({
      role: 'tool',
      toolCallId: 'call_agent',
      content: [{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }],
      });
  });

  it('seals a partial assistant when closing an unanswered trailing call', () => {
    const assistant: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'delegating the follow-up' }],
      toolCalls: [agentCall],
      partial: true,
    };
    const seed = closeTrailingOpenToolExchange([user, assistant]);

    expect(seed[1]).toMatchObject({ role: 'assistant', partial: undefined });
    expect(seed[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_agent',
      content: [{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }],
    });
  });

  it('fills only the unanswered calls of a partially answered parallel batch', () => {
    const assistant: ContextMessage = {
      role: 'assistant',
      content: [],
      toolCalls: [readCall, agentCall],
    };
    const answered: ContextMessage = {
      role: 'tool',
      toolCallId: 'call_read',
      content: [{ type: 'text', text: 'contents' }],
      };
    const seed = closeTrailingOpenToolExchange([user, assistant, answered]);

    expect(seed).toHaveLength(4);
    expect(seed.slice(0, 3)).toEqual([user, assistant, answered]);
    expect(seed[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_agent',
      content: [{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }],
    });
  });
});
