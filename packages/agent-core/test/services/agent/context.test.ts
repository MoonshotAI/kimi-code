import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { estimateTokensForMessages } from '../../../src/utils/tokens';
import { testAgent } from './harness';
import {
  project,
  renderNotificationXml,
  type ContextMessage,
} from '../../../src/services/agent';

describe('Agent context', () => {
  it('stores prompt origins without leaking them to LLM projection', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.appendSystemReminder('Remember this.', { kind: 'injection', variant: 'host' });
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_origin', name: 'Run', arguments: '{}' }],
      },
    ]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCalls: [],
        toolCallId: 'call_origin',
      },
    ]);

    expect(ctx.context.getHistory().map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
      { role: 'assistant', origin: undefined },
      { role: 'tool', origin: undefined },
    ]);
    expect(ctx.project().some((message) => 'origin' in message)).toBe(false);
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call_error', name: 'Run', arguments: '{}' },
          { type: 'function', id: 'call_empty', name: 'Run', arguments: '{}' },
        ],
      },
    ]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'tool',
        content: [
          { type: 'text', text: '<system>ERROR: Tool execution failed.</system>\npermission denied' },
        ],
        toolCalls: [],
        toolCallId: 'call_error',
      },
    ]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    ]);

    expect(ctx.project()).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call_error' }, { id: 'call_empty' }] },
      {
        role: 'tool',
        content: [
          { type: 'text', text: '<system>ERROR: Tool execution failed.</system>\npermission denied' },
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

    expect(project(history)).toEqual([
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
      {
        role: 'user',
        content: [{ type: 'text', text: '   ' }],
        toolCalls: [],
      },
    ]);
    expect(history[0]?.content).toEqual([
      { type: 'text', text: '' },
      { type: 'text', text: 'Run the tool' },
    ]);
    expect(history[1]?.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('rejects tool result messages left empty by LLM projection cleanup', () => {
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

    expect(() => project(history)).toThrow(
      'Tool result message content cannot be empty after removing empty text blocks.',
    );
  });

  it('projects hook result messages into LLM projection', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendUserMessage([{ type: 'text', text: 'hooked input' }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
    }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
    }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'user',
      content: [{ type: 'text', text: 'continue from stop hook' }],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'Stop' },
    }]);

    expect(ctx.context.getHistory()).toHaveLength(4);
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
    await ctx.expectResumeMatches();
  });

  it('projects blocked UserPromptSubmit prompts into LLM projection', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendUserMessage([{ type: 'text', text: 'blocked prompt' }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
    }]);
    ctx.appendUserMessage([{ type: 'text', text: 'safe followup' }]);

    expect(ctx.context.getHistory()).toHaveLength(3);
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
    await ctx.expectResumeMatches();
  });

  it('projects user, assistant, tool call, and tool result records into LLM history', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.profile.update({ activeToolNames: [] });
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
    await ctx.expectResumeMatches();
  });

  it('keeps system reminders separate from real user prompts', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.profile.update({ activeToolNames: [] });
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
    const ctx = testAgent();
    ctx.configure();

    ctx.appendUserMessage([{ type: 'text', text: 'load a skill' }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'assistant',
      content: [],
      toolCalls: [
        { type: 'function', id: 'call_write', name: 'Write', arguments: '{}' },
        { type: 'function', id: 'call_skill', name: 'Skill', arguments: '{}' },
      ],
    }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' }],
      toolCalls: [],
      origin: {
        kind: 'skill_activation',
        activationId: 'act_skill',
        skillName: 'demo',
        trigger: 'model-tool',
      },
    }]);

    // Raw history records the reminder in insertion order, behind the open
    // exchange.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    // The projector keeps the reminder behind the exchange — closing the open
    // calls (synthetic results) and placing the reminder after them.
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'tool',
      content: [{ type: 'text', text: 'wrote file' }],
      toolCalls: [],
      toolCallId: 'call_write',
    }]);
    // The real result is pulled up; the still-open call is synthesized.
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);

    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'tool',
      content: [{ type: 'text', text: 'skill loaded' }],
      toolCalls: [],
      toolCallId: 'call_skill',
    }]);

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
    await ctx.expectResumeMatches();
  });

  it('preserves deferred reminders when compaction keeps a pending tool exchange', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendUserMessage([{ type: 'text', text: 'old prompt' }]);
    ctx.appendContextPartiallyResolvedParallelToolExchange();

    ctx.appendSystemReminder('first reminder', {
      kind: 'injection',
      variant: 'host',
    });
    ctx.context.spliceHistory(0, 1, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'summary of old prompt' }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    }]);
    ctx.appendSystemReminder('second reminder', {
      kind: 'injection',
      variant: 'host',
    });

    // The open second call is synthesized; both reminders stay deferred behind
    // the closed exchange.
    expect(ctx.project().map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user',
    ]);

    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'tool',
      content: [{ type: 'text', text: 'two result' }],
      toolCalls: [],
      toolCallId: 'call_open_two',
    }]);

    expect(ctx.project().map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user',
    ]);
    expect(ctx.project()[5]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nfirst reminder\n</system-reminder>' },
    ]);
    expect(ctx.project()[6]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nsecond reminder\n</system-reminder>' },
    ]);
    await ctx.expectResumeMatches();
  });

  it('clears context before the next LLM request', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.profile.update({ activeToolNames: [] });
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
    await ctx.expectResumeMatches();
  });

  it('uses compacted summary plus recent messages', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.profile.update({ activeToolNames: [] });
    ctx.appendUserMessage([{ type: 'text', text: 'old user message' }]);
    ctx.appendUserMessage([{ type: 'text', text: 'recent user message' }]);
    ctx.context.spliceHistory(
      0,
      1,
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'summary of old context' }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        },
      ],
      20,
    );
    expect(ctx.context.getHistory()[0]?.origin).toEqual({ kind: 'compaction_summary' });

    ctx.mockNextResponse({ type: 'text', text: 'after compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'new prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        assistant: text "summary of old context"
        user: text "recent user message"
        user: text "new prompt"
    `);
    await ctx.expectResumeMatches();
  });

  it('includes new user messages as pending until the next usage update', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(ctx.contextSize.getStatus().contextTokens).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next user prompt'.repeat(20) }]);

    const pendingMessages = ctx.context.getHistory().slice(-1);
    expect(ctx.contextSize.getStatus().contextTokensWithPending).toBe(
      ctx.contextSize.getStatus().contextTokens + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps tool results pending when step usage covers only through the assistant message', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendUserMessage([{ type: 'text', text: 'lookup pending tokens' }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'call_pending_tokens', name: 'Lookup', arguments: '{}' }],
      },
    ]);
    ctx.contextSize.measure(ctx.context.getHistory().length, 1_280);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'large tool result '.repeat(50) }],
        toolCalls: [],
        toolCallId: 'call_pending_tokens',
      },
    ]);

    const pendingMessages = ctx.context.getHistory().slice(-1);
    expect(ctx.contextSize.getStatus().contextTokens).toBe(1_280);
    expect(ctx.contextSize.getStatus().contextTokensWithPending).toBe(
      1_280 + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps zero-usage steps pending instead of zeroing tokenCount', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(ctx.contextSize.getStatus().contextTokens).toBe(1_000);

    ctx.appendUserMessage([{ type: 'text', text: 'next prompt' }]);

    expect(ctx.contextSize.getStatus().contextTokens).toBe(1_000);
    expect(ctx.contextSize.getStatus().contextTokensWithPending).toBeGreaterThanOrEqual(
      ctx.contextSize.getStatus().contextTokens,
    );
  });

  it('undo only counts real user prompts, skipping background notifications', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendAssistantText(1, 'first response');
    ctx.appendAssistantText(2, 'second response');

    // Append a background task notification (role: 'user' but not a real prompt)
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'user',
      content: [{ type: 'text', text: 'background task completed' }],
      toolCalls: [],
      origin: {
        kind: 'background_task',
        taskId: 'bash-001',
        status: 'completed',
        notificationId: 'task:bash-001:completed',
      },
    }]);

    expect(ctx.context.getHistory().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    ctx.undoHistory(1);

    // Should remove the background notification, the second assistant, and the second user prompt
    expect(ctx.context.getHistory().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('stops at compaction summary and records the requested undo count', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendUserMessage([{ type: 'text', text: 'old user message' }]);
    ctx.context.spliceHistory(
      0,
      1,
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'summary of compacted context' }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        },
      ],
      20,
    );
    ctx.appendUserMessage([{ type: 'text', text: 'recent user message' }]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'recent answer' }],
      toolCalls: [],
      origin: undefined,
    }]);
    ctx.newEvents();

    expect(() => {
      ctx.undoHistory(2);
    }).toThrow(
      'Cannot undo 2 prompts; only 1 prompt can be undone in the active context after the last compaction.',
    );

    expect(ctx.context.getHistory()).toEqual([
      expect.objectContaining({
        role: 'assistant',
        origin: { kind: 'compaction_summary' },
        content: [{ type: 'text', text: 'summary of compacted context' }],
      }),
    ]);
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'context.splice',
        args: expect.objectContaining({ deleteCount: 1, messages: [] }),
      }),
    );
  });

  it('does not throw while restoring an undo that stops at compaction summary', async () => {
    const ctx = testAgent();
    ctx.configure();

    await expect(
      ctx.wireRecord.restore([
        { type: 'metadata', protocol_version: '1.4', created_at: 1 },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'old user message' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 1,
        },
        {
          type: 'context.apply_compaction',
          summary: 'summary of compacted context',
          compactedCount: 1,
          tokensBefore: 100,
          tokensAfter: 20,
          time: 2,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'recent user message' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 3,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'recent answer' }],
            toolCalls: [],
          },
          time: 4,
        },
        { type: 'context.undo', count: 2, time: 5 },
      ]),
    ).resolves.not.toThrow();
    expect(ctx.context.getHistory()).toEqual([
      expect.objectContaining({
        role: 'assistant',
        origin: { kind: 'compaction_summary' },
        content: [{ type: 'text', text: 'summary of compacted context' }],
      }),
    ]);
  });

  it('preserves injection messages when undo removes the surrounding turn', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [userMessage('do the work', { kind: 'user' })]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [userMessage('Plan mode is active', {
      kind: 'injection',
      variant: 'plan_mode',
    })]);
    ctx.context.spliceHistory(ctx.context.getHistory().length, 0, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'work done' }],
      toolCalls: [],
      origin: undefined,
    }]);

    ctx.undoHistory(1);

    expect(ctx.context.getHistory()).toEqual([
      expect.objectContaining({
        role: 'user',
        origin: { kind: 'injection', variant: 'plan_mode' },
      }),
    ]);
  });

});

describe('Agent context notification projection', () => {
  it('renders task notifications with escaped attributes and generic children', () => {
    const text = renderNotificationXml({
      id: 'n_"1&2',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg&1',
      title: 'Task finished',
      severity: 'info',
      body: 'The task completed.',
      children: [
        [
          '<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">',
          'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
          '</output-file>',
        ].join('\n'),
      ],
    });

    expect(text).toContain('id="n_&quot;1&amp;2"');
    expect(text).toContain('source_id="bg&amp;1"');
    expect(text).toContain('Title: Task finished');
    expect(text).toContain('Severity: info');
    expect(text).toContain('<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">');
    expect(text).toContain(
      'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
    );
    expect(text).not.toContain('<task-notification>');
    expect(text.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('renders an agent_id attribute when the notification carries one', () => {
    // Background agent tasks (taskId starts with `agent-`) own a separate
    // `agent_id` for the spawned subagent. Surfacing it as a top-level XML
    // attribute lets the LLM resume the right thing without having to dig
    // it out of the body or cross-reference the spawn-success ToolResult.
    const text = renderNotificationXml({
      id: 'n_lost1',
      category: 'task',
      type: 'task.lost',
      source_kind: 'background_task',
      source_id: 'agent-w7gq3wwj',
      agent_id: 'agent-0',
      title: 'Background agent lost',
      severity: 'warning',
      body: 'Background agent 1 lost.',
    });

    expect(text).toContain('source_id="agent-w7gq3wwj"');
    expect(text).toContain('agent_id="agent-0"');
  });

  it('omits the agent_id attribute when the notification does not carry one', () => {
    const text = renderNotificationXml({
      id: 'n_bash',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bash-abcdef00',
      title: 'Background task completed',
      severity: 'info',
      body: 'echo done completed.',
    });

    expect(text).not.toContain('agent_id=');
  });

  it('does not render task output blocks for non-task notifications', () => {
    const text = renderNotificationXml({
      id: '',
      source_kind: 'host',
      tail_output: 'should stay out of the XML',
    });

    expect(text).toContain('id="unknown"');
    expect(text).toContain('category="unknown"');
    expect(text).not.toContain('<task-notification>');
    expect(text).not.toContain('should stay out of the XML');
  });

  it('does not merge a cron-fire envelope into an adjacent user message', () => {
    const cronEnvelope =
      '<cron-fire jobId="deadbeef" cron="*/5 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>';
    const messages = project([
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
    const messages = project([
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
    const messages = project([
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
