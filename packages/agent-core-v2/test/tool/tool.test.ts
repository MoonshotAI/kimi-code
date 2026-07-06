import { Readable, type Writable } from 'node:stream';

import type { ToolCall } from '#/app/llmProtocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { HookEngine } from '#/agent/externalHooks/engine';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { IProcess, ISessionProcessRunner } from '#/session/process';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
  type TestAgentContext,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

describe('Agent tools', () => {
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  describe('PreToolUse blocking', () => {
    let exec: ReturnType<typeof vi.fn>;
    let triggered: Array<[string, string, number]>;

    beforeEach(() => {
      exec = vi.fn<ISessionProcessRunner['exec']>().mockRejectedValue(new Error('Bash should not execute'));
      triggered = [];
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
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFakeProcessRunner({ exec: exec as unknown as ISessionProcessRunner['exec'] }) }),
        externalHookServices(hookEngine),
      );
      context = ctx.get(IAgentContextMemoryService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('blocks tools before permission and emits PostToolUseFailure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(triggered).toEqual([
        ['PreToolUse', 'Bash', 1],
        ['PostToolUseFailure', 'Bash', 1],
      ]);
      expect(JSON.stringify(context.get())).toContain('blocked by PreToolUse');
    });
  });

  describe('successful Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
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
      ctx = createTestAgent(
        execEnvServices({ processRunner: createCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('runs PreToolUse before successful tools and emits PostToolUse with output', async () => {
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
  });

  describe('failed Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
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
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFailingCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('emits PostToolUseFailure with payload when a builtin tool execution fails', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash failed.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Bash', 'allow']]);
      });
    });
  });

  describe('Bash tool call start event', () => {
    beforeEach(async () => {
      ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner('ok') }));
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
    });

    it('uses builtin descriptions on tool call start events', async () => {
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
  });

  describe.skip('foreground Agent tool recovery', () => {
    // TODO: rewrite against the new session/agentLifecycle/tools/agent surface.
    // The old `AgentToolRunOverride` seam is gone; equivalent tests will stub
    // `IAgentLifecycleService.spawn` + a fake child scope's prompt turn.
    let runOverride: unknown;

    beforeEach(() => {
      runOverride = undefined;
    });

    it('continues after a foreground Agent tool returns a max_tokens failure', async () => {
      expect(runOverride).toBeUndefined();
    });
  });

  describe('registered user tool failure hooks', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      resolved = [];
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
      ctx = createTestAgent(externalHookServices(hookEngine));
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
    });

    it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
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
  });

  describe('active builtin tool set', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Write', 'Bash'] });
    });

    it('uses the active builtin tool set as the LLM visible tools', async () => {
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
  });

  describe('Bash background mode', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('disables Bash background mode unless task management tools are active', async () => {
      const bashOnly = ctx.toolsData().find((tool) => tool.name === 'Bash');
      const bashTool = tools.resolve('Bash');
      expect(bashOnly).toBeDefined();
      expect(bashTool).toBeDefined();
      expect(bashOnly!.description).toContain('Background execution is disabled for this agent.');
      expect(bashOnly!.description).not.toContain('the command will be started as a background task');
      await expect(
        executeTool(bashTool!, {
          turnId: 0,
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
  });

  describe('AgentSwarm visibility', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['AgentSwarm'] });
    });

    it('exposes AgentSwarm by default', () => {
      expect(ctx.toolsData().some((tool) => tool.name === 'AgentSwarm')).toBe(true);
    });
  });

  describe('registered user tools', () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };

    beforeEach(async () => {
      ctx = createTestAgent();
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
    });

    it('routes registered user tools through tool.call request/response', async () => {
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
        [wire] context.splice             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
        [wire] turn.launch                { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started               { "turnId": 0, "origin": { "kind": "user" } }
        [wire] context.splice             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" } ], "time": "<time>" }
        [emit] turn.step.started          { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] assistant.delta            { "turnId": 0, "delta": "I will look it up." }
        [emit] tool.call.delta            { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [wire] usage.record               { "model": "mock-model", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated       { "usage": { "byModel": { "mock-model": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice             { "start": 2, "deleteCount": 0, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context.splice             { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] } ], "time": "<time>" }
        [wire] context_size.measured      { "length": 3, "tokens": 104, "time": "<time>" }
        [emit] agent.status.updated       { "contextTokens": 104 }
        [emit] tool.call.started          { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] toolCall                   { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Agent, AgentSwarm, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, GetGoal, Glob, Grep, Lookup, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, UpdateGoal, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "moon-result" } ], "toolCalls": [], "toolCallId": "call_lookup", "id": "<msg-4>" } ], "time": "<time>" }
        [emit] tool.result             { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_calls" }
        [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "The lookup result is moon-result." }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 5, "tokens": 120, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 120 }
        [wire] context.splice          { "start": 4, "deleteCount": 1, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 0 }
        [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
        [emit] turn.ended              { "turnId": 0, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
    `);
      await ctx.rpc.unregisterTool({ name: 'Lookup' });
      ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
        [wire] context.splice               { "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "id": "<msg-6>" } ], "time": "<time>" }
        [wire] turn.launch                  { "turnId": 1, "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user" } }
        [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
        [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 1 }, "time": "<time>" }
        [emit] agent.status.updated         { "usage": { "byModel": { "mock-model": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice               { "start": 6, "deleteCount": 0, "messages": [ { "id": "<msg-7>", "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured        { "length": 7, "tokens": 138, "time": "<time>" }
        [emit] agent.status.updated         { "contextTokens": 138 }
        [wire] context.splice               { "start": 6, "deleteCount": 1, "messages": [ { "id": "<msg-7>", "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [], "providerMessageId": "mock-3" } ], "time": "<time>" }
        [emit] agent.status.updated         { "contextTokens": 0 }
        [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
        [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: Agent, AgentSwarm, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, UpdateGoal, Write
        messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
      `);
    });
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

function createFailingCommandRunner(stdout: string): ISessionProcessRunner {
  function createProcess(): IProcess {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: vi.fn().mockResolvedValue(2) as IProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    exec: vi.fn().mockImplementation(async () => createProcess()),
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
