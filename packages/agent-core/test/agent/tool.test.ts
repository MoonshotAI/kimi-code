import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { ToolManager } from '../../src/agent/tool';
import { HookEngine } from '../../src/session/hooks';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

describe('ToolManager setActiveTools filtering', () => {
  it('filters out unregistered profile tools from the active set', () => {
    const warnings: string[] = [];
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: (msg: string) => { warnings.push(msg); } },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    // Populate builtinTools map directly to simulate registered tools
    (tm as any).builtinTools.set('Read', { name: 'Read', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Write', { name: 'Write', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Bash', { name: 'Bash', description: '', parameters: {}, resolveExecution: vi.fn() });

    // Set active tools — WebSearch and NonExistentTool are not registered
    tm.setActiveTools(['Read', 'Write', 'Bash', 'WebSearch', 'NonExistentTool']);

    // Check active tools via toolInfos
    const activeNames = [...tm.toolInfos()]
      .filter((i) => i.active)
      .map((i) => i.name)
      .toSorted();
    expect(activeNames).toEqual(['Bash', 'Read', 'Write']);

    // Check warning was logged with missing tool names
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('are not available');
    expect(warnings[0]).toContain('WebSearch');
    expect(warnings[0]).toContain('NonExistentTool');
    // Read should not be mentioned as missing
    expect(warnings[0]).not.toContain('Read');
  });

  it('keeps all tools when all profile names are registered', () => {
    const warnings: string[] = [];
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: (msg: string) => { warnings.push(msg); } },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    (tm as any).builtinTools.set('Read', { name: 'Read', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Write', { name: 'Write', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Bash', { name: 'Bash', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Grep', { name: 'Grep', description: '', parameters: {}, resolveExecution: vi.fn() });
    (tm as any).builtinTools.set('Glob', { name: 'Glob', description: '', parameters: {}, resolveExecution: vi.fn() });

    tm.setActiveTools(['Read', 'Write', 'Bash', 'Grep', 'Glob']);

    const activeNames = [...tm.toolInfos()]
      .filter((i) => i.active)
      .map((i) => i.name)
      .toSorted();
    expect(activeNames).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'Write']);
    expect(warnings.length).toBe(0);
  });

  it('does not warn when all tools are available', () => {
    const warnings: string[] = [];
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: (msg: string) => { warnings.push(msg); } },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    (tm as any).builtinTools.set('Read', { name: 'Read', description: '', parameters: {}, resolveExecution: vi.fn() });

    tm.setActiveTools(['Read']);
    expect(warnings.length).toBe(0);
  });

  it('defers builtin tool names as pending when builtins not yet initialized', () => {
    const warnings: string[] = [];
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: (msg: string) => { warnings.push(msg); } },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    // builtinTools map is empty — simulate pre-initialization state

    tm.setActiveTools(['Read', 'Write', 'Bash']);

    // No warning because builtins are not yet initialized
    expect(warnings.length).toBe(0);

    // Active set is empty since no builtins are registered
    const activeNames = [...tm.toolInfos()]
      .filter((i) => i.active)
      .map((i) => i.name);
    expect(activeNames).toEqual([]);

    // Names should be stored as pending
    expect((tm as any).pendingBuiltinToolNames).toEqual(['Read', 'Write', 'Bash']);
  });

  it('resolves previously deferred tools when setActiveTools is recalled after builtin init', () => {
    const makeTool = (name: string) => ({ name, description: '', parameters: {}, resolveExecution: vi.fn() });
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: vi.fn() },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    // builtinTools empty — pre-init state

    // First call: builtins not initialized — names deferred
    tm.setActiveTools(['Read', 'Write']);
    expect((tm as any).pendingBuiltinToolNames).toEqual(['Read', 'Write']);

    // Builtins become available
    (tm as any).builtinTools.set('Read', makeTool('Read'));
    (tm as any).builtinTools.set('Write', makeTool('Write'));

    // Second call: builtins populated — names resolve
    tm.setActiveTools(['Read', 'Write']);
    expect((tm as any).pendingBuiltinToolNames).toEqual([]);

    const activeNames = [...tm.toolInfos()]
      .filter((i) => i.active)
      .map((i) => i.name)
      .toSorted();
    expect(activeNames).toEqual(['Read', 'Write']);
    // No warning because all tools resolved
    expect(agent.log.warn).not.toHaveBeenCalled();
  });

  it('warns about tools still missing when builtins were already initialized', () => {
    const warnings: string[] = [];
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: (msg: string) => { warnings.push(msg); } },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    // Populate builtins BEFORE setActiveTools (simulates initialized state)
    (tm as any).builtinTools.set('Read', { name: 'Read', description: '', parameters: {}, resolveExecution: vi.fn() });

    // Call setActiveTools with a genuinely missing tool
    tm.setActiveTools(['Read', 'BogusTool']);

    // Warning should fire immediately (builtins already initialized)
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('BogusTool');
    expect(warnings[0]).toContain('not available');

    // Read should be active, BogusTool should not
    const activeNames = [...tm.toolInfos()]
      .filter((i) => i.active)
      .map((i) => i.name);
    expect(activeNames).toEqual(['Read']);
  });

  it('only keeps pending builtin names when the replacement set contains unresolved tools', () => {
    const agent = {
      records: { logRecord: vi.fn() },
      config: { hasProvider: false },
      log: { warn: vi.fn(), info: vi.fn() },
      mcp: undefined,
      emitEvent: vi.fn(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);
    // builtins empty — pre-init state

    // First call: task tools saved as pending (missing builtins)
    tm.setActiveTools(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']);
    expect((tm as any).pendingBuiltinToolNames).toEqual([
      'Bash', 'TaskList', 'TaskOutput', 'TaskStop',
    ]);

    // Second call: user-tool-only replacement — clears pending because
    // this is a replacement, not an incremental addition. The new active
    // set explicitly replaces the previous one.
    const userTool = {
      name: 'UserTool', description: '', parameters: {},
      resolveExecution: vi.fn(),
    };
    (tm as any).userTools.set('UserTool', userTool);
    tm.setActiveTools(['UserTool']);
    expect((tm as any).pendingBuiltinToolNames).toEqual([]);
    expect([...tm.toolInfos()].filter((t) => t.active).map((t) => t.name)).toEqual(['UserTool']);

    // Third call: re-establish pending
    tm.setActiveTools(['Bash', 'TaskList', 'TaskOutput', 'TaskStop']);
    expect((tm as any).pendingBuiltinToolNames).toEqual([
      'Bash', 'TaskList', 'TaskOutput', 'TaskStop',
    ]);

    // Fourth call: MCP-only — no non-MCP names, acts like empty replacement
    tm.setActiveTools(['mcp__*']);
    expect((tm as any).pendingBuiltinToolNames).toEqual([]);
  });

  it('enables Bash background mode when task tools arrive via pendingBuiltinToolNames', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    const tm = ctx.agent.tools;
    // Simulate deferred profile: task tools are in pending, not in enabledTools
    (tm as any).pendingBuiltinToolNames = [
      'Bash', 'TaskList', 'TaskOutput', 'TaskStop',
    ];

    // Re-initialize builtins — allowBackground computation should pick up
    // pending task tools and construct Bash with run_in_background=true.
    tm.initializeBuiltinTools();

    const bashTool = tm.loopTools.find((t) => t.name === 'Bash');
    expect(bashTool).toBeDefined();
    expect(bashTool!.description).toContain('run_in_background=true');
  });

  it('re-resolves deferred pending tool names when they become available in a later initializeBuiltinTools call', () => {
    const makeTool = (name: string) => ({ name, description: '', parameters: {}, resolveExecution: vi.fn() });
    const warnings: string[] = [];
    const infos: string[] = [];

    const agent = {
      records: { logRecord: vi.fn() },
      config: {
        hasProvider: false,
        cwd: '/workspace',
        provider: {} as import('@moonshot-ai/kosong').ChatProvider,
        modelCapabilities: {} as import('@moonshot-ai/kosong').ModelCapability,
      },
      log: { warn: (msg: string) => { warnings.push(msg); }, info: (msg: string) => { infos.push(msg); } },
      experimentalFlags: { enabled: () => false },
      mcp: undefined,
      emitEvent: vi.fn(),
      background: {} as unknown as import('../../src/agent').Agent['background'],
      modelProvider: undefined,
      cron: undefined,
      skills: undefined,
      subagentHost: undefined,
      toolServices: undefined,
      rpc: undefined,
      kaos: createFakeKaos(),
    } as unknown as import('../../src/agent').Agent;

    const tm = new ToolManager(agent);

    // Step 1: pre-init — setActiveTools defers names not in builtinTools
    tm.setActiveTools(['Bash', 'ReadMediaFile']);
    expect((tm as any).pendingBuiltinToolNames).toEqual(['Bash', 'ReadMediaFile']);
    expect((tm as any).enabledTools.size).toBe(0);

    // Step 2: first initializeBuiltinTools — ReadMediaFile NOT in builtinTools
    tm.initializeBuiltinTools();
    // ReadMediaFile stays in pending (not cleared)
    expect((tm as any).pendingBuiltinToolNames).toEqual(['ReadMediaFile']);
    // Warning fired
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('ReadMediaFile');
    expect(warnings[0]).toContain('not available');

    // Step 3: tool becomes available — model now supports image_in
    (agent.config as any).modelCapabilities = { image_in: true };

    // Step 4: second initializeBuiltinTools — ReadMediaFile now resolves
    tm.initializeBuiltinTools();
    expect((tm as any).pendingBuiltinToolNames).toEqual([]);
    expect((tm as any).enabledTools.has('ReadMediaFile')).toBe(true);
    // No second warning
    expect(warnings.length).toBe(1);
    // Info logged about re-application (Bash on first call, ReadMediaFile on second)
    expect(infos.length).toBe(2);
    expect(infos[1]).toContain('ReadMediaFile');
  });
});

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
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 104, "maxContextTokens": 1000000, "contextUsage": 0.000104, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The lookup result is moon-result." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 120, "maxContextTokens": 1000000, "contextUsage": 0.00012, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
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
      [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
      [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
      [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "1", "step": 1, "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-5>", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated         { "model": "mock-model", "contextTokens": 138, "maxContextTokens": 1000000, "contextUsage": 0.000138, "planMode": false, "swarmMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
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
