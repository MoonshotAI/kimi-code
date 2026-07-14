import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { budgetToolResultForModel } from '../../src/agent/turn/tool-result-budget';
import type { KimiConfig } from '../../src/config';
import { HookEngine } from '../../src/session/hooks';
import { ProviderManager } from '../../src/session/provider-manager';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

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
          command: 'node -e "process.stderr.write(\'blocked by PreToolUse\'); process.exit(2)"',
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
    expect(JSON.stringify(ctx.agent.context.data().history)).toContain('blocked by PreToolUse');
  });

  it('emits PostToolUse after successful tools', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUse',
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
      kaos: createCommandKaos('ok'),
      hookEngine,
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['PostToolUse', 'Bash', 1]]);
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
    await ctx.expectResumeMatches();
  });

  it('disables Bash background mode unless task management tools are active', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    const bashOnly = ctx.agent.tools.loopTools.find((tool) => tool.name === 'Bash');
    expect(bashOnly).toBeDefined();
    expect(bashOnly!.description).toContain('Background execution is disabled for this agent.');
    expect(bashOnly!.description).not.toContain('the command will be started as a background task');
    await expect(
      executeTool(bashOnly!, {
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

    ctx.agent.tools.setActiveTools(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']);

    const managedBash = ctx.agent.tools.loopTools.find((tool) => tool.name === 'Bash');
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

    expect(ctx.agent.tools.loopTools.some((tool) => tool.name === 'AgentSwarm')).toBe(true);
  });

  it('self-heals the builtin tool table when the provider becomes resolvable after construction', () => {
    // The ProviderManager reads this live config; it starts with no model or
    // provider, so hasProvider is false at Agent construction and
    // initializeBuiltinTools() is skipped — the state the asynchronous
    // free-tokens / OAuth model registration produces.
    const liveConfig: KimiConfig = { providers: {}, models: {} };
    const ctx = testAgent({
      providerManager: new ProviderManager({ config: () => liveConfig }),
    });

    // Aim at a model that cannot resolve yet and enable some tools. Neither call
    // runs a gated re-init because hasProvider is still false, so the enabled
    // tools have no builtin backing and are not dispatchable.
    ctx.agent.config.update({ modelAlias: 'late-model' });
    ctx.agent.tools.setActiveTools(['Bash', 'Read', 'Glob']);
    expect(ctx.agent.tools.loopTools.some((tool) => tool.name === 'Bash')).toBe(false);

    // The provider registers asynchronously: the config the ProviderManager reads
    // now resolves the model, but no agent config.update fires, so none of the
    // hasProvider-gated checkpoints re-run initializeBuiltinTools().
    liveConfig.providers['late-provider'] = { type: 'kimi', apiKey: 'late-key' };
    liveConfig.models!['late-model'] = {
      provider: 'late-provider',
      model: 'late-model',
      maxContextSize: 1_000_000,
      capabilities: [],
    };

    // loopTools self-heals on read: the builtin table is populated and the
    // enabled tools become dispatchable instead of reporting "Tool not found".
    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['Bash', 'Read', 'Glob']));
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
      [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "auto" }
      [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_lookup", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Lookup
      messages:
        user: text "Look up moon"
        user: text <auto-mode-enter-reminder>
    `);

    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_lookup", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 160, "maxContextTokens": 1000000, "contextUsage": 0.00016, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999840, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The lookup result is moon-result." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 176, "maxContextTokens": 1000000, "contextUsage": 0.000176, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
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
      [wire] turn.prompt                  { "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user" } }
      [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-5>" }
      [wire] llm.tools_snapshot           { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                  { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999824, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 6, "turnStep": "1.1", "time": "<time>" }
      [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
      [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
      [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "1", "step": 1, "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-3" }, "time": "<time>" }
      [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-5>", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated         { "model": "mock-model", "contextTokens": 194, "maxContextTokens": 1000000, "contextUsage": 0.000194, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        <last>
        assistant: text "The lookup result is moon-result."
        user: text "Can you still use Lookup?"
    `);
    await ctx.expectResumeMatches();
  });

  it('persists oversized registered tool results before adding them to model context', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      const largeOutput = `${'x'.repeat(60_000)}tail survives`;
      const ctx = testAgent({ homedir: sessionDir });
      ctx.configure();
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: { type: 'object', properties: {} },
      });

      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({ output: largeOutput });

      ctx.mockNextResponse({ type: 'text', text: 'done' });
      await ctx.untilTurnEnd();

      const toolText = ctx.compactHistory().find((message) => message.role === 'tool')?.text ?? '';
      const outputPath = /^output_path: (.+)$/m.exec(toolText)?.[1];
      expect(toolText).toContain('Tool output exceeded 50000 characters');
      expect(toolText).not.toContain('tail survives');
      expect(outputPath).toBeTruthy();
      expect(readFileSync(outputPath!, 'utf8')).toBe(largeOutput);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite saved oversized tool results with repeated call IDs', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const firstOutput = `${'a'.repeat(60_000)}first tail`;
      const secondOutput = `${'b'.repeat(60_000)}second tail`;

      const first = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result: { output: firstOutput },
      });
      const second = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result: { output: secondOutput },
      });

      const firstPath = savedOutputPath(first.output);
      const secondPath = savedOutputPath(second.output);
      expect(firstPath).not.toBe(secondPath);
      expect(readFileSync(firstPath, 'utf8')).toBe(firstOutput);
      expect(readFileSync(secondPath, 'utf8')).toBe(secondOutput);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps oversized tool results intact when no session directory is available', async () => {
    const largeOutput = `${'x'.repeat(60_000)}tail survives`;
    const result = { output: largeOutput };

    const budgeted = await budgetToolResultForModel({
      toolName: 'Lookup',
      toolCallId: 'call_lookup',
      result,
    });

    expect(budgeted).toBe(result);
    expect(budgeted.output).toBe(largeOutput);
  });

  it('does not save already-truncated tool result previews as full output', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'tool-result-overflow-'));
    try {
      const largeOutput = `${'x'.repeat(60_000)}[...truncated]`;
      const result = {
        output: largeOutput,
        truncated: true,
      };

      const budgeted = await budgetToolResultForModel({
        homedir: sessionDir,
        toolName: 'Lookup',
        toolCallId: 'call_lookup',
        result,
      });

      expect(budgeted).toBe(result);
      expect(budgeted.output).toBe(largeOutput);
      expect(budgeted.output).not.toContain('output_path:');
      expect(existsSync(join(sessionDir, 'tool-results'))).toBe(false);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
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

function savedOutputPath(output: unknown): string {
  expect(typeof output).toBe('string');
  const outputPath = /^output_path: (.+)$/m.exec(output as string)?.[1];
  expect(outputPath).toBeTruthy();
  return outputPath!;
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
