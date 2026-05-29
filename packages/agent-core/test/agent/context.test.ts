import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { renderNotificationXml } from '../../src/agent/context/notification-xml';
import { project } from '../../src/agent/context/projector';
import type { ContextMessage } from '../../src/agent/context/types';
import { estimateTokensForMessages } from '../../src/utils/tokens';
import { testAgent } from './harness/agent';

describe('Agent context', () => {
  it('stores prompt origins without leaking them to LLM projection', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hello' }]);
    ctx.agent.context.appendSystemReminder('Remember this.', { kind: 'injection', variant: 'host' });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'origin-step', turnId: '', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 'origin-step', turnId: '', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'origin-tool',
        toolCallId: 'call_origin',
        result: { output: 'tool output' },
      },
    });

    expect(ctx.agent.context.history.map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
      { role: 'assistant', origin: undefined },
      { role: 'tool', origin: undefined },
    ]);
    expect(ctx.agent.context.messages.some((message) => 'origin' in message)).toBe(false);
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_error',
        toolCallId: 'call_error',
        result: { output: 'permission denied', isError: true },
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_empty',
        toolCallId: 'call_empty',
        result: { output: '' },
      },
    });

    expect(ctx.agent.context.messages).toMatchObject([
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

  it('projects hook result messages into LLM projection', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hooked input' }]);
    ctx.agent.context.appendMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
    });
    ctx.agent.context.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
    });
    ctx.agent.context.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'continue from stop hook' }],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'Stop' },
    });

    expect(ctx.agent.context.history).toHaveLength(4);
    expect(ctx.agent.context.messages).toEqual([
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

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'blocked prompt' }]);
    ctx.agent.context.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'safe followup' }]);

    expect(ctx.agent.context.history).toHaveLength(3);
    expect(ctx.agent.context.messages).toEqual([
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
    ctx.agent.context.appendSystemReminder('Remember the host note.', {
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
    const stepUuid = 'skill-batch-step';

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'load a skill' }]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '0', step: 1 },
    });
    for (const [toolCallId, name] of [
      ['call_write', 'Write'],
      ['call_skill', 'Skill'],
    ] as const) {
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: toolCallId,
          turnId: '0',
          step: 1,
          stepUuid,
          toolCallId,
          name,
          args: {},
        },
      });
    }

    ctx.dispatch({
      type: 'context.append_message',
      message: {
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
    });

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual(['user', 'assistant']);

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: stepUuid,
        turnId: '0',
        step: 1,
        finishReason: 'tool_use',
      },
    });
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual(['user', 'assistant']);

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_write',
        toolCallId: 'call_write',
        result: { output: 'wrote file' },
      },
    });
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_skill',
        toolCallId: 'call_skill',
        result: { output: 'skill loaded' },
      },
    });

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.agent.context.messages[4]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nskill body\n</system-reminder>' },
    ]);
    await ctx.expectResumeMatches();
  });

  it('preserves deferred reminders when compaction keeps a pending tool exchange', async () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'old prompt' }]);
    ctx.appendContextPartiallyResolvedParallelToolExchange();

    ctx.agent.context.appendSystemReminder('first reminder', {
      kind: 'injection',
      variant: 'host',
    });
    ctx.agent.context.applyCompaction({
      summary: 'summary of old prompt',
      compactedCount: 1,
      tokensBefore: 100,
      tokensAfter: 40,
    });
    ctx.agent.context.appendSystemReminder('second reminder', {
      kind: 'injection',
      variant: 'host',
    });

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'tool',
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

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.messages[5]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nfirst reminder\n</system-reminder>' },
    ]);
    expect(ctx.agent.context.messages[6]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nsecond reminder\n</system-reminder>' },
    ]);
    await ctx.expectResumeMatches();
  });

  it('clears context before the next LLM request', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'stale user message' }]);
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
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'old user message' }]);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'recent user message' }]);
    ctx.agent.context.applyCompaction({
      summary: 'summary of old context',
      compactedCount: 1,
      tokensBefore: 100,
      tokensAfter: 20,
    });
    expect(ctx.agent.context.history[0]?.origin).toEqual({ kind: 'compaction_summary' });

    ctx.mockNextResponse({ type: 'text', text: 'after compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'new prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        assistant: text "summary of old context"
        user: text "recent user message\\n\\nnew prompt"
    `);
    await ctx.expectResumeMatches();
  });

  it('includes new user messages as pending until the next usage update', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(ctx.agent.context.tokenCountWithPending).toBe(1_000);

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'next user prompt'.repeat(20) }]);

    const pendingMessages = ctx.agent.context.history.slice(-1);
    expect(ctx.agent.context.tokenCountWithPending).toBe(
      ctx.agent.context.tokenCount + estimateTokensForMessages(pendingMessages),
    );
  });

  it('keeps tool results pending when step usage covers only through the assistant message', () => {
    const ctx = testAgent();
    ctx.configure();
    const stepUuid = 'context-pending-tool-step';
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'lookup pending tokens' }]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '0', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_pending_tokens',
        turnId: '0',
        step: 1,
        stepUuid,
        toolCallId: 'call_pending_tokens',
        name: 'Lookup',
        args: {},
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_pending_tokens',
        toolCallId: 'call_pending_tokens',
        result: { output: 'large tool result '.repeat(50) },
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: stepUuid,
        turnId: '0',
        step: 1,
        usage: {
          inputOther: 1_200,
          output: 80,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        finishReason: 'tool_use',
      },
    });

    const pendingMessages = ctx.agent.context.history.slice(-1);
    expect(ctx.agent.context.tokenCount).toBe(1_280);
    expect(ctx.agent.context.tokenCountWithPending).toBe(
      1_280 + estimateTokensForMessages(pendingMessages),
    );
  });

});

describe('Agent context notification projection', () => {
  it('renders task notifications with escaped attributes and a bounded output tail', () => {
    const tail = Array.from({ length: 25 }, (_, index) => `line ${String(index + 1)}`).join('\n');

    const text = renderNotificationXml({
      id: 'n_"1&2',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg&1',
      title: 'Task finished',
      severity: 'info',
      body: 'The task completed.',
      tail_output: tail,
    });

    expect(text).toContain('id="n_&quot;1&amp;2"');
    expect(text).toContain('source_id="bg&amp;1"');
    expect(text).toContain('Title: Task finished');
    expect(text).toContain('Severity: info');
    expect(text).toContain('<task-notification>');
    expect(text).not.toContain('line 5');
    expect(text).toContain('line 6');
    expect(text).toContain('line 25');
    expect(text.trimEnd()).toMatch(/<\/notification>$/);
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
