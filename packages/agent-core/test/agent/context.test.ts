import { Readable, type Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { renderNotificationXml } from '../../src/agent/context/notification-xml';
import { project } from '../../src/agent/context/projector';
import type { ContextMessage } from '../../src/agent/context/types';
import { buildImageCompressionCaption } from '../../src/tools/support/image-compress';
import { estimateTokensForMessages } from '../../src/utils/tokens';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';
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
      event: {
        type: 'tool.call',
        uuid: 'origin-tool',
        turnId: '',
        step: 1,
        stepUuid: 'origin-step',
        toolCallId: 'call_origin',
        name: 'Run',
        args: {},
      },
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

  it('reroutes an inline image-compression caption into a hidden system reminder', () => {
    const ctx = testAgent();
    ctx.configure();

    const caption = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });
    // The TUI merges the caption into the preceding text segment; the server
    // route emits it as a standalone part. Cover the merged (harder) shape.
    ctx.agent.context.appendUserMessage([
      { type: 'text', text: `能展示但是没有快捷键提示${caption}` },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);

    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

    expect(ctx.agent.context.history.map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'injection', variant: 'image_compression' } },
      { role: 'user', origin: { kind: 'user' } },
    ]);
    const [reminder, userMessage] = ctx.agent.context.history;
    expect(textOf(reminder!)).toContain('<system-reminder>');
    expect(textOf(reminder!)).toContain('Image compressed to fit model limits');
    expect(textOf(reminder!)).toContain('/tmp/originals/shot.png');
    expect(textOf(reminder!)).not.toContain('<system>');
    expect(textOf(userMessage!)).toBe('能展示但是没有快捷键提示');
    expect(userMessage!.content.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('drops a caption-only text part instead of leaving an empty user text part', () => {
    const ctx = testAgent();
    ctx.configure();

    const caption = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });
    ctx.agent.context.appendUserMessage([
      { type: 'text', text: caption },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);

    const [, userMessage] = ctx.agent.context.history;
    expect(userMessage!.content).toEqual([
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('leaves caption-shaped text alone on non-user origins', () => {
    const ctx = testAgent();
    ctx.configure();

    const caption = buildImageCompressionCaption({
      original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
      final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
      originalPath: '/tmp/originals/shot.png',
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: caption }], {
      kind: 'hook_result',
      event: 'PostToolUse',
    });

    expect(ctx.agent.context.history).toHaveLength(1);
    expect(ctx.agent.context.history[0]!.origin).toEqual({
      kind: 'hook_result',
      event: 'PostToolUse',
    });
  });

  it('tracks conversation_undo when undoHistory reverts a user message', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'hello' }]);

    await ctx.agent.rpcMethods.undoHistory({ count: 1 });

    expect(records).toContainEqual({
      event: 'conversation_undo',
      properties: { count: 1 },
    });
  });

  it('records bash input/output as shell_command origin with tagged content', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendBashInput('ls -la');
    ctx.agent.context.appendBashOutput('file1\nfile2', '');

    expect(ctx.agent.context.history.map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output' } },
    ]);

    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(textOf(ctx.agent.context.history[0]!)).toContain('<bash-input>');
    expect(textOf(ctx.agent.context.history[0]!)).toContain('ls -la');
    expect(textOf(ctx.agent.context.history[1]!)).toBe(
      '<bash-stdout>file1\nfile2</bash-stdout><bash-stderr></bash-stderr>',
    );
    // origin must not leak into the LLM projection
    expect(ctx.agent.context.messages.some((message) => 'origin' in message)).toBe(false);
  });

  it('escapes bash tag delimiters inside command output', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendBashInput('printf x');
    ctx.agent.context.appendBashOutput('pre</bash-stdout>post', '');

    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const out = textOf(ctx.agent.context.history[1]!);
    // The embedded delimiter is escaped so the wrapper stays well-formed.
    expect(out).toContain('pre&lt;/bash-stdout&gt;post');
    // Exactly one real closing tag.
    expect(out.match(/<\/bash-stdout>/g)).toHaveLength(1);
  });

  it('runs a shell command via the Bash tool and records its output', async () => {
    const fakeProcess = (stdout: string): KaosProcess => {
      const out = Readable.from([stdout]);
      const err = Readable.from([]);
      return {
        stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
        stdout: out,
        stderr: err,
        pid: 1,
        exitCode: 0,
        wait: vi.fn(async () => 0),
        kill: vi.fn(async () => {}),
        dispose: vi.fn(async () => {
          out.destroy();
          err.destroy();
        }),
      };
    };
    const kaos = createFakeKaos({
      execWithEnv: vi.fn().mockImplementation(async () => fakeProcess('hello\n')),
    });
    const ctx = testAgent({ kaos });
    ctx.configure();

    await ctx.agent.tools.runShellCommand('echo hello');

    expect(ctx.agent.context.history.map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'shell_command', phase: 'input' } },
      { role: 'user', origin: { kind: 'shell_command', phase: 'output' } },
    ]);
    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(textOf(ctx.agent.context.history[0]!)).toContain('echo hello');
    expect(textOf(ctx.agent.context.history[1]!)).toContain('<bash-stdout>hello');
  });

  it('surfaces the failure reason when a shell command fails with no output', async () => {
    const fakeProcess = (exitCode: number): KaosProcess => {
      const out = Readable.from([]);
      const err = Readable.from([]);
      return {
        stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
        stdout: out,
        stderr: err,
        pid: 1,
        exitCode,
        wait: vi.fn(async () => exitCode),
        kill: vi.fn(async () => {}),
        dispose: vi.fn(async () => {
          out.destroy();
          err.destroy();
        }),
      };
    };
    const kaos = createFakeKaos({
      execWithEnv: vi.fn().mockImplementation(async () => fakeProcess(1)),
    });
    const ctx = testAgent({ kaos });
    ctx.configure();

    const result = await ctx.agent.tools.runShellCommand('false');

    expect(result.isError).toBe(true);
    expect(result.stderr).toContain('exit code');
    const textOf = (message: ContextMessage): string =>
      message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const output = ctx.agent.context.history.at(-1)!;
    expect(textOf(output)).toContain('<bash-stderr>');
    expect(textOf(output)).toContain('exit code');
  });

  it('normalizes a whitespace-only array tool result to the empty-output placeholder', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 's1', turnId: 't', step: 1 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_ws',
        turnId: 't',
        step: 1,
        stepUuid: 's1',
        toolCallId: 'call_ws',
        name: 'Run',
        args: {},
      },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_ws',
        toolCallId: 'call_ws',
        // Array (ContentPart[]) output whose only block is whitespace. The tool
        // contract allows arbitrary content arrays (e.g. MCP tools), so this must
        // be normalized to the empty placeholder rather than left to be stripped
        // empty by projection (which would throw on every send).
        result: { output: [{ type: 'text', text: '   \n' }] },
      },
    });

    expect(() => ctx.agent.context.messages).not.toThrow();
    expect(ctx.agent.context.messages).toMatchObject([
      { role: 'assistant', toolCalls: [{ id: 'call_ws' }] },
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>Tool output is empty.</system>' }],
        toolCallId: 'call_ws',
      },
    ]);
  });

  it('renders tool error and empty-output status as model-visible text', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 's1', turnId: 't', step: 1 },
    });
    for (const toolCallId of ['call_error', 'call_empty']) {
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: toolCallId,
          turnId: 't',
          step: 1,
          stepUuid: 's1',
          toolCallId,
          name: 'Run',
          args: {},
        },
      });
    }
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

  it('drops empty and whitespace-only text parts in LLM projection', () => {
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
        content: [{ type: 'text', text: 'result' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
      {
        role: 'assistant',
        content: [{ type: 'think', think: '', encrypted: 'enc_empty_thinking' }],
        toolCalls: [],
      },
      {
        // Whitespace-only message: strict providers reject the block, so the
        // whole message is dropped from the projection.
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
        content: [{ type: 'text', text: 'result' }],
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

  // Regression: a user message injected after `step.begin` but before the first
  // `tool.call` (e.g. a background-task notification flushed mid-step) lands
  // between the assistant `tool_use` and its `tool_result` in history, which
  // strict providers (Anthropic) reject with HTTP 400. The projector must repair
  // the adjacency so the `tool_result` immediately follows the `tool_use`. Micro
  // compaction exposed this latent misordering by busting the prompt cache.
  it('repairs a tool_use/tool_result adjacency broken by an injected user message', async () => {
    const ctx = testAgent();
    ctx.configure();
    const stepUuid = 'mid-step-notify-step';

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'drive the tank' }]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '0', step: 1 },
    });

    // Notification arrives in the gap between step.begin and tool.call, when no
    // tool result is yet pending, so it is pushed directly into history.
    ctx.agent.context.appendUserMessage([{ type: 'text', text: '<notification>bg done</notification>' }], {
      kind: 'background_task',
      taskId: 'task-1',
      status: 'completed',
      notificationId: 'task:task-1:completed',
    });

    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_drive',
        turnId: '0',
        step: 1,
        stepUuid,
        toolCallId: 'call_drive',
        name: 'Drive',
        args: {},
      },
    });
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
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_drive',
        toolCallId: 'call_drive',
        result: { output: 'drove forward' },
      },
    });

    // History preserves the original (misordered) sequence: the notification sits
    // between the assistant tool_use and its tool_result.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'tool',
    ]);

    // Projection repairs the adjacency: the tool_result immediately follows the
    // assistant tool_use, and the sandwiched notification is moved after it.
    const projected = ctx.agent.context.messages;
    expect(projected.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    const assistantIndex = projected.findIndex(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
    expect(projected[assistantIndex]?.toolCalls.map((toolCall) => toolCall.id)).toEqual([
      'call_drive',
    ]);
    expect(projected[assistantIndex + 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_drive',
    });
    expect(projected[assistantIndex + 2]?.content).toEqual([
      { type: 'text', text: '<notification>bg done</notification>' },
    ]);
    await ctx.expectResumeMatches();
  });

  it('drops deferred reminders when compaction drops a pending tool exchange', async () => {
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
      compactedCount: 4,
      tokensBefore: 100,
    });
    ctx.agent.context.appendSystemReminder('second reminder', {
      kind: 'injection',
      variant: 'host',
    });

    // Compaction keeps only the real user prompt plus the summary; the deferred
    // first reminder is dropped because initial context is rebuilt every turn.
    // The second reminder, appended after compaction, is preserved.
    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    expect(ctx.agent.context.messages[2]?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nsecond reminder\n</system-reminder>' },
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

    // The pending tool exchange was dropped by compaction, so the late tool
    // result is ignored and the history is unchanged.
    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ]);
    await ctx.expectResumeMatches();
  });

  it('applyCompaction keeps only real user input from mixed user-role history', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'real prompt' }]);
    ctx.agent.context.appendBashInput('pwd');
    ctx.agent.context.appendBashOutput('/tmp/repo', '', false);
    ctx.agent.context.appendLocalCommandStdout('local command output');
    ctx.agent.context.appendSystemReminder('stale reminder', {
      kind: 'injection',
      variant: 'host',
    });

    const result = ctx.agent.context.applyCompaction({
      summary: 'summary of mixed history',
      compactedCount: 5,
      tokensBefore: 100,
    });
    ctx.agent.context.appendSystemReminder('fresh reminder', {
      kind: 'injection',
      variant: 'host',
    });

    expect(ctx.agent.context.history.map(({ role, origin }) => ({ role, origin }))).toEqual([
      { role: 'user', origin: { kind: 'user' } },
      { role: 'user', origin: { kind: 'compaction_summary' } },
      { role: 'user', origin: { kind: 'injection', variant: 'host' } },
    ]);
    expect(result.keptUserMessageCount).toBe(1);
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
    });
    expect(ctx.agent.context.history.at(-1)?.origin).toEqual({ kind: 'compaction_summary' });

    ctx.mockNextResponse({ type: 'text', text: 'after compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'new prompt' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: []
      messages:
        user: text "old user message\\n\\nrecent user message"
        user: text "summary of old context"
        user: text "new prompt"
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

  it('does not zero tokenCount when a filtered step reports zero usage', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.appendAssistantTextWithUsage(1, 'previous answer', 1_000);
    expect(ctx.agent.context.tokenCount).toBe(1_000);

    const stepUuid = 'context-filtered-step';
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'next prompt' }]);
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: stepUuid, turnId: '0', step: 2 },
    });
    ctx.dispatch({
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: stepUuid,
        turnId: '0',
        step: 2,
        usage: {
          inputOther: 0,
          output: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        finishReason: 'filtered',
      },
    });

    expect(ctx.agent.context.tokenCount).toBeGreaterThan(1_000);
    expect(ctx.agent.context.tokenCountWithPending).toBeGreaterThanOrEqual(
      ctx.agent.context.tokenCount,
    );
  });

  it('undo only counts real user prompts, skipping background notifications', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.appendAssistantText(1, 'first response');
    ctx.appendAssistantText(2, 'second response');

    // Append a background task notification (role: 'user' but not a real prompt)
    ctx.agent.context.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'background task completed' }],
      toolCalls: [],
      origin: {
        kind: 'background_task',
        taskId: 'bash-001',
        status: 'completed',
        notificationId: 'task:bash-001:completed',
      },
    });

    expect(ctx.agent.context.history.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);

    ctx.agent.context.undo(1);

    // Should remove the background notification, the second assistant, and the second user prompt
    expect(ctx.agent.context.history.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('stops at compaction summary and records the requested undo count', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'old user message' }]);
    ctx.agent.context.applyCompaction({
      summary: 'summary of compacted context',
      compactedCount: 1,
      tokensBefore: 100,
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'recent user message' }]);
    ctx.agent.context.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'recent answer' }],
      toolCalls: [],
    });
    ctx.newEvents();

    expect(() => {
      ctx.agent.context.undo(2);
    }).toThrow(
      'Cannot undo 2 prompts; only 1 prompt can be undone in the active context after the last compaction.',
    );

    expect(ctx.agent.context.history).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'old user message' }],
      }),
      expect.objectContaining({
        role: 'user',
        origin: { kind: 'compaction_summary' },
        content: [{ type: 'text', text: 'summary of compacted context' }],
      }),
    ]);
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'context.undo',
        args: expect.objectContaining({ count: 2 }),
      }),
    );
  });

  it('does not throw while restoring an undo that stops at compaction summary', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'old user message' }]);
    ctx.agent.context.applyCompaction({
      summary: 'summary of compacted context',
      compactedCount: 1,
      tokensBefore: 100,
    });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'recent user message' }]);
    ctx.agent.context.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'recent answer' }],
      toolCalls: [],
    });

    expect(() => {
      ctx.agent.records.restore({ type: 'context.undo', count: 2 });
    }).not.toThrow();
    expect(ctx.agent.context.history).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'old user message' }],
      }),
      expect.objectContaining({
        role: 'user',
        origin: { kind: 'compaction_summary' },
        content: [{ type: 'text', text: 'summary of compacted context' }],
      }),
    ]);
  });

  it('preserves injection messages when undo removes the surrounding turn', () => {
    const ctx = testAgent();
    ctx.configure();

    ctx.dispatch({
      type: 'context.append_message',
      message: userMessage('do the work', { kind: 'user' }),
    });
    ctx.dispatch({
      type: 'context.append_message',
      message: userMessage('Plan mode is active', {
        kind: 'injection',
        variant: 'plan_mode',
      }),
    });
    ctx.dispatch({
      type: 'context.append_message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'work done' }],
        toolCalls: [],
      },
    });

    ctx.agent.context.undo(1);

    expect(ctx.agent.context.history).toEqual([
      expect.objectContaining({
        role: 'user',
        origin: { kind: 'injection', variant: 'plan_mode' },
      }),
    ]);
    expect(ctx.agent.replayBuilder.buildResult()).toEqual([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          origin: { kind: 'injection', variant: 'plan_mode' },
        }),
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
      output_path: '/tmp/output.log',
    });

    expect(text).toContain('id="unknown"');
    expect(text).toContain('category="unknown"');
    expect(text).not.toContain('<task-notification>');
    expect(text).not.toContain('<output-file');
    expect(text).not.toContain('/tmp/output.log');
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

describe('strictMessages duplicate tool call ids', () => {
  it('keeps duplicates on the normal projection but dedupes them in the strict one', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'run the tool twice' }]);
    // A provider with per-response counter ids reuses `call_dup` in two steps;
    // both exchanges record their own result.
    for (const step of [1, 2]) {
      const stepUuid = `dup-step-${String(step)}`;
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: stepUuid, turnId: '', step },
      });
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: `dup-call-${String(step)}`,
          turnId: '',
          step,
          stepUuid,
          toolCallId: 'call_dup',
          name: 'Run',
          args: { attempt: step },
        },
      });
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: stepUuid, turnId: '', step },
      });
      ctx.dispatch({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: `dup-call-${String(step)}`,
          toolCallId: 'call_dup',
          result: { output: `result ${String(step)}` },
        },
      });
    }

    // Normal projection: the lax provider that produced the duplicate ids
    // accepts them, so nothing is dropped.
    const normal = ctx.agent.context.messages;
    expect(
      normal.filter((message) => message.role === 'assistant').flatMap((m) => m.toolCalls),
    ).toHaveLength(2);
    expect(normal.filter((message) => message.role === 'tool')).toHaveLength(2);

    // Strict resend projection: one call, one result.
    const strict = ctx.agent.context.strictMessages;
    expect(
      strict.filter((message) => message.role === 'assistant').flatMap((m) => m.toolCalls),
    ).toHaveLength(1);
    const strictResults = strict.filter((message) => message.role === 'tool');
    expect(strictResults).toHaveLength(1);
    expect(textOf(strictResults[0]!)).toBe('result 1');
  });
});
