import { Readable, type Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../../src/session/hooks';
import type { SessionSubagentHost } from '../../../src/session/subagent-host';
import { FLAG_DEFINITIONS, FlagResolver } from '../../../src/flags';
import { createFakeKaos } from '../../tools/fixtures/fake-kaos';
import { testAgent, createCommandKaos } from './harness';
import { executeTool } from '../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

describe('Agent tools', () => {
  it('blocks tools through PreToolUse before permission and emits PostToolUseFailure', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: "echo 'blocked by PreToolUse' >&2; exit 2",
        },
        {
          event: 'PostToolUseFailure',
          matcher: 'Bash',
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
      kaos: createFakeKaos({ execWithEnv }),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

    await ctx.untilTurnEnd();

    expect(execWithEnv).not.toHaveBeenCalled();
    expect(triggered).toEqual([
      ['PreToolUse', 'Bash', 1],
      ['PostToolUseFailure', 'Bash', 1],
    ]);
    expect(JSON.stringify(ctx.context.getHistory())).toContain('blocked by PreToolUse');
  });

  it('runs PreToolUse before successful tools and emits PostToolUse with output', async () => {
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: hookPayloadAssertCommand({
            event: 'PreToolUse',
            toolName: 'Bash',
            toolCallId: 'call_bash',
            toolInputCommand: 'printf hook-output',
          }),
        },
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: hookPayloadAssertCommand({
            event: 'PostToolUse',
            toolName: 'Bash',
            toolCallId: 'call_bash',
            toolInputCommand: 'printf hook-output',
            toolOutput: 'hook-output',
          }),
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({
      kaos: createCommandKaos('hook-output'),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash returned hook-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([
        ['PreToolUse', 'Bash', 'allow'],
        ['PostToolUse', 'Bash', 'allow'],
      ]);
    });
  });

  it('emits PostToolUseFailure with payload when a builtin tool execution fails', async () => {
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUseFailure',
          matcher: 'Bash',
          command: hookPayloadAssertCommand({
            event: 'PostToolUseFailure',
            toolName: 'Bash',
            toolCallId: 'call_bash',
            toolInputCommand: 'printf hook-output',
            errorMessageIncludes: 'hook-output\nCommand failed with exit code: 2.',
          }),
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({
      kaos: createFailingCommandKaos('hook-output'),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash failed.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([['PostToolUseFailure', 'Bash', 'allow']]);
    });
  });

  it('uses builtin descriptions on tool call start events', async () => {
    const ctx = testAgent({
      kaos: createCommandKaos('ok'),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
    await ctx.untilTurnEnd();

    const started = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
    );
    expect(started?.args).toMatchObject({
      description: 'Running: printf hook-output',
    });
  });

  it('continues after a foreground Agent tool returns a max_tokens failure', async () => {
    const completion = Promise.reject(
      new Error('Subagent turn failed before completing its final summary: reason=max_tokens.'),
    );
    void completion.catch(() => undefined);
    const subagentHost = {
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
      resume: vi.fn(),
    } as unknown as SessionSubagentHost;
    const ctx = testAgent({ subagentHost });
    ctx.configure({ tools: ['Agent'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will ask a subagent.' }, agentCall());
    ctx.mockNextResponse({
      type: 'text',
      text: 'The subagent failed with reason=max_tokens, so I will continue in the parent turn.',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Delegate and recover' }] });
    await ctx.untilTurnEnd();

    expect(subagentHost.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'Investigate deeply',
        description: 'Investigate deeply',
        runInBackground: false,
      }),
    );
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'tool.result',
        args: expect.objectContaining({
          toolCallId: 'call_agent',
          isError: true,
          output: expect.stringContaining('reason=max_tokens'),
        }),
      }),
    );
    expect(JSON.stringify(ctx.llmCalls[1]?.history)).toContain('reason=max_tokens');
  });

  it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUseFailure',
          matcher: 'Lookup',
          command: hookErrorMessageAssertCommand('rich failure text'),
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    await ctx.untilToolCall({
      isError: true,
      output: [{ type: 'text', text: 'rich failure text' }],
    });

    ctx.mockNextResponse({ type: 'text', text: 'The lookup failed.' });
    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([['PostToolUseFailure', 'Lookup', 'allow']]);
    });
  });

  it('uses the active builtin tool set as the LLM visible tools', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Write', 'Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'ready' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Which tools are active?' }] });

    await ctx.untilTurnEnd();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash, Write
      messages:
        user: text "Which tools are active?"
    `);
  });

  it('disables Bash background mode unless task management tools are active', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    const bashOnly = ctx.toolsData().find((tool) => tool.name === 'Bash');
    const bashTool = ctx.tools.resolve('Bash');
    expect(bashOnly).toBeDefined();
    expect(bashTool).toBeDefined();
    expect(bashOnly!.description).toContain('Background execution is disabled for this agent.');
    expect(bashOnly!.description).not.toContain('the command will be started as a background task');
    await expect(
      executeTool(bashTool!, {
        turnId: '0',
        toolCallId: 'call_bash',
        args: { command: 'sleep 10', run_in_background: true, description: 'watch' },
        signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      output:
        'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
    });

    await ctx.rpc.setActiveTools({ names: ['Bash', 'TaskList', 'TaskOutput', 'TaskStop'] });

    const managedBash = ctx.toolsData().find((tool) => tool.name === 'Bash');
    expect(managedBash).toBeDefined();
    expect(managedBash!.description).toContain('run_in_background=true');
  });

  it('exposes AgentSwarm when a subagent host is available', () => {
    const subagentHost = {} as unknown as SessionSubagentHost;

    const ctx = testAgent({
      subagentHost,
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
    });
    ctx.configure({ tools: ['AgentSwarm'] });

    expect(ctx.toolsData().some((tool) => tool.name === 'AgentSwarm')).toBe(true);
  });

  it('routes registered user tools through tool.call request/response', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const ctx = testAgent();
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    expect(
      await ctx.untilToolCall({
        content: 'moon-result',
        output: 'moon-result',
      }),
    ).toMatchInlineSnapshot(`
      [wire] permission.set_mode        { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated       { "permission": "auto" }
      [wire] tools.register_user_tool   { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
      [wire] context.splice             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch                { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started               { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.splice             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } } ], "time": "<time>" }
      [emit] turn.step.started          { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta            { "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta            { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [wire] context.splice             { "start": 2, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] usage.record               { "model": "mock-model", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated       { "usage": { "byModel": { "mock-model": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice             { "start": 2, "deleteCount": 1, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] } ], "time": "<time>" }
      [wire] context_size.measured      { "length": 3, "tokens": 104, "time": "<time>" }
      [emit] agent.status.updated       { "contextTokens": 104, "maxContextTokens": 1000000, "contextUsage": 0.000104 }
      [emit] tool.call.started          { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] toolCall                   { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Lookup, Read, TaskList, TaskOutput, TaskStop, TodoList, Write
      messages:
        user: text "Look up moon"
        user: text <auto-mode-enter-reminder>
    `);

    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "moon-result" } ], "toolCalls": [], "toolCallId": "call_lookup" } ], "time": "<time>" }
      [emit] tool.result             { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
      [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
      [emit] assistant.delta         { "turnId": 0, "delta": "The lookup result is moon-result." }
      [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context_size.measured   { "length": 5, "tokens": 120, "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 120, "maxContextTokens": 1000000, "contextUsage": 0.00012 }
      [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended              { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
    `);
    await ctx.expectResumeMatches();

    await ctx.rpc.unregisterTool({ name: 'Lookup' });
    ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
      [wire] context.splice               { "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch                  { "turnId": 1, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user" } }
      [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
      [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
      [wire] context.splice               { "start": 6, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated         { "usage": { "byModel": { "mock-model": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context_size.measured        { "length": 7, "tokens": 138, "time": "<time>" }
      [emit] agent.status.updated         { "contextTokens": 138, "maxContextTokens": 1000000, "contextUsage": 0.000138 }
      [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, TaskList, TaskOutput, TaskStop, TodoList, Write
      messages:
        <last>
        assistant: text "The lookup result is moon-result."
        user: text "Can you still use Lookup?"
    `);
  });
});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf hook-output","timeout":60}',
  };
}

function createFailingCommandKaos(stdout: string): ReturnType<typeof createFakeKaos> {
  function createProcess(): KaosProcess {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: vi.fn().mockResolvedValue(2),
      kill: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }

  return createFakeKaos({
    execWithEnv: vi.fn().mockImplementation(async () => createProcess()),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn(async (_path: string, content: string) => content.length),
  });
}

function agentCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_agent',
    name: 'Agent',
    arguments: JSON.stringify({
        prompt: 'Investigate deeply',
        description: 'Investigate deeply',
        subagent_type: 'coder',
      }),
  };
}

function hookErrorMessageAssertCommand(expected: string): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.error?.message === ${JSON.stringify(expected)}) process.exit(0);`,
    "  console.error(payload.error?.message ?? '<missing>');",
    '  process.exit(2);',
    '});',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}

function hookPayloadAssertCommand(expected: {
  readonly event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInputCommand: string;
  readonly toolOutput?: string;
  readonly errorMessageIncludes?: string;
}): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.hook_event_name !== ${JSON.stringify(expected.event)}) throw new Error('bad event: ' + payload.hook_event_name);`,
    `  if (payload.tool_name !== ${JSON.stringify(expected.toolName)}) throw new Error('bad tool_name: ' + payload.tool_name);`,
    `  if (payload.tool_call_id !== ${JSON.stringify(expected.toolCallId)}) throw new Error('bad tool_call_id: ' + payload.tool_call_id);`,
    `  if (payload.tool_input?.command !== ${JSON.stringify(expected.toolInputCommand)}) throw new Error('bad command: ' + payload.tool_input?.command);`,
    expected.toolOutput === undefined
      ? ''
      : `  if (payload.tool_output !== ${JSON.stringify(expected.toolOutput)}) throw new Error('bad tool_output: ' + payload.tool_output);`,
    expected.toolOutput === undefined
      ? ''
      : "  if (payload.error !== undefined) throw new Error('unexpected error payload');",
    expected.errorMessageIncludes === undefined
      ? ''
      : `  if (typeof payload.error?.message !== 'string' || !payload.error.message.includes(${JSON.stringify(expected.errorMessageIncludes)})) throw new Error('bad error: ' + payload.error?.message);`,
    expected.errorMessageIncludes === undefined
      ? ''
      : "  if (payload.tool_output !== undefined) throw new Error('unexpected tool_output: ' + payload.tool_output);",
    '  process.exit(0);',
    '});',
    "process.on('uncaughtException', (error) => { console.error(error.message); process.exit(2); });",
  ].filter((line) => line.length > 0).join('');
  return `node -e ${JSON.stringify(script)}`;
}
