import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'pathe';
import { setTimeout as delay } from 'node:timers/promises';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  type ChatProvider,
  type ModelCapability,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { abortError, abortable } from '#/_base/utils/abort';
import { IAgentFileSystem } from '#/agentFs';
import type { ContextMessage } from '#/contextMemory';
import { IOAuthService } from '#/auth';
import { ErrorCodes, KimiError } from '#/errors';
import { HookEngine } from '#/externalHooks/engine';
import { IKaos } from '#/kaos';
import type { ILogger as Logger, LogPayload } from '#/log';
import { IMcpService } from '#/mcp';
import { McpConnectionManager } from '#/mcp/connection-manager';
import { registerMediaTools, type VideoUploader } from '#/media';
import { IPermissionGate } from '#/permissionGate';
import { IProfileService } from '#/profile';
import { ISwarmService } from '#/swarm';
import { ITurnService } from '#/turn';
import { IToolRegistry } from '#/toolRegistry';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from '#/subagentHost';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import {
  configServices,
  coreServices,
  createCommandKaos,
  kaosServices,
  logServices,
  mcpServices,
  subagentHostServices,
  testAgent,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { logger, entries };
}

describe('Agent turn flow', () => {
  it('waits for MCP initial load before executing tools', async () => {
    const mcp = new McpConnectionManager();
    let resolveInitialLoad: () => void = () => {};
    const initialLoad = new Promise<void>((resolve) => {
      resolveInitialLoad = resolve;
    });
    const waitForInitialLoad = vi
      .spyOn(mcp, 'waitForInitialLoad')
      .mockImplementation((signal?: AbortSignal) =>
        signal === undefined ? initialLoad : abortable(initialLoad, signal),
    );
    const { kaos, execWithEnv } = createExecKaos('mcp-ready');
    const ctx = testAgent(mcpServices({ manager: mcp }), kaosServices(kaos));
    ctx.get(IMcpService);
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse(
      { type: 'text', text: 'I will run Bash after MCP is ready.' },
      bashCallWithId('call_mcp_wait', 'printf mcp-ready'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for MCP' }] });
    await vi.waitFor(() => {
      expect(waitForInitialLoad).toHaveBeenCalledTimes(1);
    });

    expect(execWithEnv).not.toHaveBeenCalled();

    resolveInitialLoad();
    await ctx.untilTurnEnd();

    expect(execWithEnv).toHaveBeenCalledTimes(1);
  });

  it('cancels the turn while waiting for MCP initial load before tool execution', async () => {
    const mcp = new McpConnectionManager();
    const initialLoad = new Promise<void>(() => undefined);
    const waitForInitialLoad = vi
      .spyOn(mcp, 'waitForInitialLoad')
      .mockImplementation((signal?: AbortSignal) =>
        signal === undefined ? initialLoad : abortable(initialLoad, signal),
    );
    const { kaos, execWithEnv } = createExecKaos('should-not-run');
    const ctx = testAgent(mcpServices({ manager: mcp }), kaosServices(kaos));
    ctx.get(IMcpService);
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse(
      { type: 'text', text: 'I will run Bash after MCP is ready.' },
      bashCallWithId('call_mcp_cancel', 'printf should-not-run'),
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Cancel before MCP ready' }] });
    await vi.waitFor(() => {
      expect(waitForInitialLoad).toHaveBeenCalledTimes(1);
    });
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('tracks turn_started and turn_interrupted telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'turn_started',
      properties: { mode: 'agent' },
    });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'agent', at_step: 1 },
    });
  });

  it('tracks duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(kaosServices(createCommandKaos('dup')), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedup_detected',
      properties: {
        turn_id: 0,
        step_no: 1,
        tool_name: 'Bash',
        dup_type: 'same_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: expect.objectContaining({
        policy_name: 'yolo-mode-approve',
        tool_name: 'Bash',
        permission_mode: 'yolo',
        decision: 'approve',
      }),
    });
  });

  it('tracks cross-step duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(kaosServices(createCommandKaos('dup')), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(bashCallWithId('call_dup_1', 'printf dup'));
    ctx.mockNextResponse(bashCallWithId('call_dup_2', 'printf dup'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates across steps' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedup_detected',
      properties: {
        turn_id: 0,
        step_no: 2,
        tool_name: 'Bash',
        dup_type: 'cross_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        tool_name: 'Bash',
        outcome: 'success',
        dup_type: 'cross_step',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('fires PostToolUse for same-step dups with the original real output, not the dedup placeholder', async () => {
    // Hook command asserts the dup's PostToolUse payload carries the real
    // stdout ('dup'), not the placeholder ('').
    const assertScript = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  const payload = JSON.parse(input);',
      "  if (typeof payload.tool_output === 'string' && payload.tool_output.includes('dup')) process.exit(0);",
      "  console.error('bad tool_output: ' + JSON.stringify(payload.tool_output));",
      '  process.exit(2);',
      '});',
    ].join('');
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: `node -e ${JSON.stringify(assertScript)}`,
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent(kaosServices(createCommandKaos('dup')), { hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([
        ['PostToolUse', 'Bash', 'allow'],
        ['PostToolUse', 'Bash', 'allow'],
      ]);
    });
  });

  it('tracks failed tool-call telemetry with error taxonomy', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();
    records.length = 0;

    ctx.mockNextResponse({
      type: 'function',
      id: 'call_missing',
      name: 'MissingTool',
      arguments: '{}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Call a missing tool' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        tool_name: 'MissingTool',
        outcome: 'error',
        dup_type: 'normal',
        error_type: 'ToolNotFound',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('emits a failed turn and error when generation fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Trigger generate failure" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch             { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started            { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started       { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] turn.step.interrupted   { "turnId": 0, "step": 1, "reason": "error", "message": "Unexpected generate call #1" }
      [emit] turn.ended              { "turnId": 0, "reason": "failed", "error": { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "details": { "turnId": 0 }, "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "details": { "turnId": 0 }, "retryable": false }`,
    );
    await ctx.expectResumeMatches();
  });

  it('removes a replayed swarm enter reminder when restoring swarm exit', async () => {
    const ctx = testAgent();
    const enterReminder: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>\nlegacy swarm enter reminder\n</system-reminder>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'swarm_mode' },
    };

    await ctx.restore([
      { type: 'swarm_mode.enter', trigger: 'manual' },
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [enterReminder],
      },
      { type: 'swarm_mode.exit' },
    ]);

    expect(ctx.get(ISwarmService).isActive).toBe(false);
    expect(ctx.contextData().history).toEqual([]);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] swarm_mode.enter   { "trigger": "manual" }
      [wire] context.splice     { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nlegacy swarm enter reminder\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "swarm_mode" } } ] }
      [wire] swarm_mode.exit    {}
    `);
  });

  it('keeps manual swarm mode active after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'manual' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(ISwarmService).isActive).toBe(true);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBe(-1);
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    const turnEndedIndex = eventIndex(ctx, '[rpc]', 'turn.ended');
    const swarmExitIndex = eventIndex(ctx, '[wire]', 'swarm_mode.exit');
    const inactiveStatusIndex = ctx.allEvents.findIndex((entry, index) => {
      return (
        index > turnEndedIndex &&
        entry.type === '[rpc]' &&
        entry.event === 'agent.status.updated' &&
        (entry.args as { readonly swarmMode?: boolean }).swarmMode === false
      );
    });

    expect(ctx.get(ISwarmService).isActive).toBe(false);
    expect(swarmExitIndex).toBeGreaterThan(turnEndedIndex);
    expect(inactiveStatusIndex).toBeGreaterThan(turnEndedIndex);
    expect(ctx.contextData().history.at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode when the swarm turn fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fail a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(ISwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('exits task swarm mode when the user cancels the swarm turn', async () => {
    const ctx = testAgent({ generate: abortableGenerate });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Cancel a swarm task' }] });
    await stepStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();

    expect(ctx.get(ISwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('enters silent swarm mode when the agent calls AgentSwarm', async () => {
    const runQueued = vi.fn(async <T>(
      tasks: readonly QueuedSubagentTask<T>[],
    ): Promise<Array<QueuedSubagentRunResult<T>>> => {
      return tasks.map((task, index) => ({
        task,
        agentId: `agent-${String(index + 1)}`,
        status: 'completed' as const,
        result: `result ${String(index + 1)}`,
      }));
    });
    const subagentHost = mockSubagentHost({
      runQueued: runQueued as unknown as SessionSubagentHost['runQueued'],
    });
    const ctx = testAgent(subagentHostServices(subagentHost));
    ctx.configure({ tools: ['AgentSwarm'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      { type: 'text', text: 'I will launch a swarm.' },
      agentSwarmCall(),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Swarm results reviewed.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use AgentSwarm' }] });
    await ctx.untilTurnEnd();

    const enterEvent = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'swarm_mode.enter',
    );
    const reminderOrigins = ctx.contextData().history
      .map((message) => message.origin)
      .filter((origin) => origin?.kind === 'injection');

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(enterEvent?.args).toMatchObject({ trigger: 'tool' });
    expect(ctx.get(ISwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(
      eventIndex(ctx, '[rpc]', 'turn.ended'),
    );
    expect(reminderOrigins).not.toContainEqual({ kind: 'injection', variant: 'swarm_mode' });
    expect(reminderOrigins).not.toContainEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('includes provider finish reason details on empty response failures', async () => {
    const generate: GenerateFn = async () => {
      throw new APIEmptyResponseError(
        'The API returned a response containing only thinking content without any text or tool calls. ' +
          'Provider stop details: finishReason=filtered, rawFinishReason=content_filter.',
        {
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
      );
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.api_error',
            name: 'APIEmptyResponseError',
            details: expect.objectContaining({
              finishReason: 'filtered',
              rawFinishReason: 'content_filter',
              turnId: 0,
            }),
          }),
        }),
      }),
    );
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'error',
        args: expect.objectContaining({
          code: 'provider.api_error',
          name: 'APIEmptyResponseError',
          details: expect.objectContaining({
            finishReason: 'filtered',
            rawFinishReason: 'content_filter',
            turnId: 0,
          }),
        }),
      }),
    );
  });

  it('ends the turn with reason filtered when the provider filters a non-empty response', async () => {
    const generate: GenerateFn = async () => ({
      id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'some filtered text' }],
        toolCalls: [],
      },
      usage: {
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'filtered',
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('emits a friendly model.not_configured error when no model is configured', async () => {
    const ctx = testAgent(configServices(() => ({ providers: {} })), { autoConfigure: false });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice   { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello without login" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch      { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started     { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.ended       { "turnId": 0, "reason": "failed", "error": { "code": "model.not_configured", "message": "LLM not set, send \\"/login\\" to login", "name": "KimiError", "details": { "turnId": 0 }, "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "model.not_configured", "message": "LLM not set, send \\"/login\\" to login", "name": "KimiError", "details": { "turnId": 0 }, "retryable": false }`,
    );
  });

  it('continues the turn after projecting UserPromptSubmit hook output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command:
          'node -e "let s=\\\"\\\";process.stdin.on(\\\"data\\\",d=>s+=d);process.stdin.on(\\\"end\\\",()=>{const o=JSON.parse(s);if(Array.isArray(o.prompt)&&o.prompt[0]?.text===\\\"hooked input\\\"){process.stdout.write(\\\"hook response 1\\\");process.exit(0);}console.error(\\\"bad prompt\\\");process.exit(1);})"',
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo 'hook response 2'",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, Write
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 1\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 2\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'hook response 1\n\nhook response 2',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: 'model saw original prompt only' }),
      }),
    );
    expect(ctx.contextData().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects structured UserPromptSubmit stdout', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo '{}'",
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'echo \'{"hookSpecificOutput":{}}\'',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, Write
      messages:
        user: text "hooked input"
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\n{}\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\n{\\"hookSpecificOutput\\":{}}\\n</hook_result>"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: '{}\n\n{"hookSpecificOutput":{}}',
        }),
      }),
    );
    expect(ctx.contextData().history).toEqual([
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
            text: '<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\n{"hookSpecificOutput":{}}\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('stops the turn when a UserPromptSubmit hook blocks', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        matcher: 'bad words',
        command: "echo 'no profanity' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'bad words here' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult = '<hook_result hook_event="UserPromptSubmit">\nno profanity\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'no profanity',
          blocked: true,
        }),
      }),
    );
    expect(ctx.contextData().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'bad words here' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'safe answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'safe followup' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, Write
      messages:
        user: text "bad words here"
        assistant: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nno profanity\\n</hook_result>"
        user: text "safe followup"
    `);
  });

  it('cancels while waiting for a UserPromptSubmit hook without appending stale output', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        command: 'node -e "setTimeout(() => process.stdout.write(\\"late hook\\"), 250)"',
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hook will sleep' }] });
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: expect.stringContaining('late hook') }),
      }),
    );
    expect(ctx.contextData().history).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hook will sleep' }],
        toolCalls: [],
      },
    ]);
  });

  it('uses a Stop hook block reason as a one-shot turn continuation', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: "echo 'continue from hook' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const stopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: 'stop_hook' },
    };
    const llmStopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
    };
    expect(JSON.stringify(ctx.contextData().history)).toContain('continue from hook');
    expect(ctx.contextData().history).toContainEqual(stopHookMessage);
    expect(ctx.llmCalls[1]?.history).toContainEqual(llmStopHookMessage);
    expect(JSON.stringify(ctx.contextData().history)).toContain('Second answer.');
  });

  it('removes an unconsumed Stop hook continuation when no step budget remains', async () => {
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: "echo 'continue from hook' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({
      hookEngine,
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Only answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('continue from hook');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('cancels while waiting for a Stop hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-stop-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stderr.write('late stop hook'), 250);",
    ].join('');
    const hookEngine = new HookEngine([
      {
        event: 'Stop',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Answer before stop hook.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('late stop hook');
  });

  it('cancels while waiting for a PreToolUse hook before permission evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pre-tool-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stdout.write('late pre tool hook'), 250);",
    ].join('');
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const hookEngine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent(kaosServices(createFakeKaos({ execWithEnv })), {
      hookEngine,
    });
    const authorize = vi.spyOn(ctx.get(IPermissionGate), 'authorize');
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    ctx.newEvents();
    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash while hook sleeps' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(authorize).not.toHaveBeenCalled();
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('late pre tool hook');
  });

  it('fires StopFailure when a turn fails', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'StopFailure',
          matcher: 'Error',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['StopFailure', 'Error', 1]]);
  });

  it('fires Interrupt when the user cancels an active turn', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ generate: abortableGenerate, hookEngine });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await stepStarted;

    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();
    await vi.waitFor(() => {
      expect(triggered).toEqual([['Interrupt', '', 1]]);
    });

    expect(triggered).toEqual([['Interrupt', '', 1]]);
  });

  it('does not fire Interrupt for a non-user (programmatic) abort', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = new HookEngine(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ generate: abortableGenerate, hookEngine });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await stepStarted;

    // A programmatic abort (e.g. a subagent deadline timeout) carries a plain
    // AbortError as its reason, not a UserCancellationError, so it must not be
    // reported as a user interrupt.
    ctx.get(ITurnService).getActiveTurn()?.abortController.abort(abortError());
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([]);
  });

  it('resolves the latest request-scoped OAuth auth before each generation', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const tokens = ['first-turn-token', 'second-turn-token'];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected token request');
      return token;
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const firstEvents = await ctx.untilTurnEnd();
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello again' }] });
    const secondEvents = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['first-turn-token', 'second-turn-token']);
    expect(tokenCalls).toEqual([undefined, undefined]);
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with first-turn-token' },
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 1, delta: 'Generated with second-turn-token' },
      }),
    );
    expect(firstEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
    expect(secondEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
  });

  it('emits LLM stream timing on step completion', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'timed answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      llmFirstTokenLatencyMs: expect.any(Number),
      llmStreamDurationMs: expect.any(Number),
    });
  });

  it('logs LLM request metadata without message bodies', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'secret prompt body should stay out of logs' }],
    });
    await ctx.untilTurnEnd();

    const configLogs = entries.filter((entry) => entry.message === 'llm config');
    expect(configLogs).toHaveLength(1);
    const configPayload = configLogs[0]?.payload as Record<string, unknown>;
    expect(configPayload).toMatchObject({
      turnStep: '0.1',
      provider: 'kimi',
      model: 'mock-model',
      modelAlias: 'mock-model',
      toolCount: 13,
    });
    expect(configPayload['systemPromptChars']).toEqual(expect.any(Number));

    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    expect(requestLogs).toHaveLength(1);
    const payload = requestLogs[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      turnStep: '0.1',
    });
    expect(payload).not.toHaveProperty('estimatedInputTokens');
    expect(payload).not.toHaveProperty('turnId');
    expect(payload).not.toHaveProperty('step');
    expect(payload).not.toHaveProperty('attempt');
    expect(payload).not.toHaveProperty('maxAttempts');
    expect(payload).not.toHaveProperty('stepUuid');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('modelAlias');
    expect(payload).not.toHaveProperty('thinkingEffort');
    expect(payload).not.toHaveProperty('systemPromptChars');
    expect(payload).not.toHaveProperty('partialMessageCount');
    expect(payload).not.toHaveProperty('messageCount');
    expect(payload).not.toHaveProperty('toolCallCount');
    expect(payload).not.toHaveProperty('toolCount');
    expect(payload).not.toHaveProperty('systemPromptHash');
    expect(payload).not.toHaveProperty('toolsHash');
    expect(payload).not.toHaveProperty('messageRoles');
    expect(payload).not.toHaveProperty('contentPartTypes');
    expect(payload).not.toHaveProperty('toolNames');
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(entries)).not.toContain('secret prompt body should stay out of logs');
  });

  it('does not repeat unchanged LLM config metadata', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    expect(entries.filter((entry) => entry.message === 'llm config')).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === 'llm request')).toHaveLength(2);
  });

  it('logs changed LLM config when same-size system prompt content changes', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();

    ctx.get(IProfileService).update({ systemPrompt: 'alpha' });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.get(IProfileService).update({ systemPrompt: 'bravo' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    const configPayloads = entries
      .filter((entry) => entry.message === 'llm config')
      .map((entry) => entry.payload as Record<string, unknown>);
    expect(configPayloads).toHaveLength(2);
    expect(configPayloads.map((payload) => payload['systemPromptChars'])).toEqual([5, 5]);
    for (const payload of configPayloads) {
      expect(payload).not.toHaveProperty('systemPromptHash');
      expect(payload).not.toHaveProperty('toolsHash');
    }
  });

  it('does not log estimated LLM request tokens when tools are present', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();
    await ctx.rpc.setActiveTools({ names: ['Bash'] });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use bash' }] });
    await ctx.untilTurnEnd();

    const input = ctx.llmCalls[0];
    expect(input?.tools.length).toBeGreaterThan(0);
    const requestPayload = entries.find((entry) => entry.message === 'llm request')?.payload as
      | Record<string, unknown>
      | undefined;
    expect(requestPayload).not.toHaveProperty('estimatedInputTokens');
  });

  it('classifies OAuth resolver connection failures as provider connection errors without retrying', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(
        ErrorCodes.PROVIDER_CONNECTION_ERROR,
        'OAuth provider "managed:kimi-code" failed to fetch an access token: fetch failed',
      );
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
            message: expect.stringContaining('fetch failed'),
            retryable: true,
          }),
        }),
      }),
    );
  });

  it('classifies explicit OAuth login-required resolver failures as auth errors', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in');
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.AUTH_LOGIN_REQUIRED,
            retryable: false,
          }),
        }),
      }),
    );
  });

  it('honors configured maxStepsPerTurn in agent turns', async () => {
    const ctx = testAgent(kaosServices(createCommandKaos('loop-output')), {
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.newEvents();

    const bashCall: ToolCall = {
      id: 'call_bash',
      type: 'function',
      name: 'Bash',
      arguments: '{"command":"printf loop-output","timeout":60}',
    };
    ctx.mockNextResponse(bashCall);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command once' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'loop.max_steps_exceeded',
            details: expect.objectContaining({
              maxSteps: 1,
            }),
          }),
        }),
      }),
    );
  });

  it('force-refreshes OAuth credentials and replays the request on 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      if (authKeys.length === 1) throw new APIStatusError(401, 'Unauthorized', 'req-401');
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with forced-refresh-token' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('falls back to login_required when force-refresh and replay both 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      throw new APIStatusError(401, 'Unauthorized', 'req-401');
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'auth.login_required',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-401',
            }),
          }),
        }),
      }),
    );
  });

  it('keeps non-OAuth provider 401 as provider auth error', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-api-key-401');
    };
    const ctx = testAgent({ generate });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.auth_error',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-api-key-401',
            }),
          }),
        }),
      }),
    );
  });

  it.each<ApiErrorTelemetryCase>([
    {
      name: '429 status',
      createError: () => new APIStatusError(429, 'Rate limited', 'req-429'),
      errorType: 'rate_limit',
      statusCode: 429,
    },
    {
      name: '401 status',
      createError: () => new APIStatusError(401, 'Unauthorized', 'req-401'),
      errorType: 'auth',
      statusCode: 401,
    },
    {
      name: '403 status',
      createError: () => new APIStatusError(403, 'Forbidden', 'req-403'),
      errorType: 'auth',
      statusCode: 403,
    },
    {
      name: '500 status',
      createError: () => new APIStatusError(500, 'Internal server error', 'req-500'),
      errorType: '5xx_server',
      statusCode: 500,
    },
    {
      name: '400 status',
      createError: () => new APIStatusError(400, 'Bad request', 'req-400'),
      errorType: '4xx_client',
      statusCode: 400,
    },
    {
      name: 'context overflow status',
      createError: () => new APIStatusError(422, 'Maximum context window exceeded', 'req-422'),
      errorType: 'context_overflow',
      statusCode: 422,
    },
    {
      name: 'context overflow token count status',
      createError: () =>
        new APIStatusError(
          400,
          'input token count 131072 exceeds the maximum number of tokens allowed',
          'req-token-count',
        ),
      errorType: 'context_overflow',
      statusCode: 400,
    },
    {
      name: 'connection error',
      createError: () => new APIConnectionError('socket hang up'),
      errorType: 'network',
    },
    {
      name: 'timeout error',
      createError: () => new APITimeoutError('request timed out'),
      errorType: 'timeout',
    },
    {
      name: 'empty response error',
      createError: () => new APIEmptyResponseError('empty response'),
      errorType: 'empty_response',
    },
    {
      name: 'generic step error',
      createError: () => new Error('unexpected step failure'),
      errorType: 'other',
    },
  ])('tracks api_error telemetry for $name', async ({ createError, errorType, statusCode }) => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw createError();
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const expectedProperties: Record<string, unknown> = {
      error_type: errorType,
      model: 'mock-model',
      retryable: expect.any(Boolean),
      duration_ms: expect.any(Number),
    };
    if (statusCode !== undefined) {
      expectedProperties['status_code'] = statusCode;
    }

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record).toEqual({
      event: 'api_error',
      properties: expect.objectContaining(expectedProperties),
    });
    if (statusCode === undefined) {
      expect(record?.properties).not.toHaveProperty('status_code');
    }
  });

  it('keeps transient retry handling with request-scoped OAuth auth', async () => {
    const { logger, entries } = captureLogs();
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async () => 'fresh-token');
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length === 1) {
        throw new APIConnectionError('socket hang up');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Recovered after retry' });
      options?.onStreamEnd?.();
      return textResult('Recovered after retry');
    };
    const ctx = testAgent(oauthOptions.services, logServices(logger), {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'fresh-token']);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.retrying',
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          errorName: 'APIConnectionError',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Recovered after retry' },
      }),
    );
    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    const payloads = requestLogs.map((entry) => entry.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ turnStep: '0.1' });
    expect(payloads[0]).not.toHaveProperty('attempt');
    expect(payloads[1]).toMatchObject({ turnStep: '0.1', attempt: '2/3' });
  });

  it('force-refreshes OAuth credentials on video upload 401 and falls back to login_required when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const provider = {
      uploadVideo: vi.fn().mockImplementation(async (_input, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        throw new APIStatusError(401, 'Unauthorized', 'req-upload-401');
      }),
    } as unknown as ChatProvider;
    const ctx = testAgent(oauthOptions.services, kaosServices(createVideoKaos()), {
      initialConfig: oauthOptions.initialConfig,
      autoConfigure: false,
    });
    const profile = ctx.get(IProfileService);
    profile.update({
      cwd: '/workspace',
      modelAlias: 'kimi-code',
      systemPrompt: 'test system prompt',
      thinkingLevel: 'off',
    });
    const withAuth = ctx.modelResolver.resolveAuth?.('kimi-code');
    if (withAuth === undefined) throw new Error('OAuth model did not resolve auth wrapper');
    const videoUploader: VideoUploader = (input) =>
      withAuth((auth) => {
        const uploadVideo = provider.uploadVideo;
        if (uploadVideo === undefined) throw new Error('Provider did not expose uploadVideo');
        return uploadVideo.call(provider, input, { auth });
      });
    const registration = registerMediaTools(ctx.get(IToolRegistry), {
      fs: ctx.get(IAgentFileSystem),
      kaos: ctx.get(IKaos),
      workspace: { workspaceDir: '/workspace', additionalDirs: [] },
      capabilities: mediaCapabilities(),
      videoUploader,
    });
    profile.update({ activeToolNames: ['ReadMediaFile'] });

    try {
      const tool = ctx.get(IToolRegistry).resolve('ReadMediaFile');
      if (tool === undefined) throw new Error('ReadMediaFile tool was not initialized');
      const result = await executeTool(tool, {
        turnId: 't1',
        toolCallId: 'call_media',
        args: { path: '/workspace/sample.mp4' },
        signal: new AbortController().signal,
      });

      expect(result.isError).toBe(true);
      expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
      expect(tokenCalls).toEqual([undefined, true]);
      expect(result.output).toContain('OAuth provider credentials were rejected');
      expect(result.output).toContain('Send /login to login');
    } finally {
      registration.dispose();
    }
  });

  it('cancels an active turn', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(kaosServices(createCommandKaos('should-not-run')), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] context.splice         { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Run a command" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch            { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started           { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started      { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta        { "turnId": 0, "delta": "I will run Bash." }
      [emit] tool.call.delta        { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] usage.record           { "model": "mock-model", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated   { "usage": { "byModel": { "mock-model": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice         { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will run Bash." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] requestApproval        { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run a command"
    `);
    records.length = 0;
    await ctx.rpc.cancel({ turnId: 0 });
    expect(records).toContainEqual({
      event: 'cancel',
      properties: { from: 'streaming' },
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] turn.step.interrupted   { "turnId": 0, "step": 1, "reason": "aborted" }
      [emit] turn.ended              { "turnId": 0, "reason": "cancelled" }
    `);
    expect(records.some((record) => record.event === 'tool_call')).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('buffers steer input and includes it in the same turn after approval', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf approved","timeout":60}',
    };
    const ctx = testAgent(kaosServices(createCommandKaos('approved')));
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will ask first.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash, then listen' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] context.splice         { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Run Bash, then listen" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch            { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started           { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started      { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta        { "turnId": 0, "delta": "I will ask first." }
      [emit] tool.call.delta        { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf approved\\",\\"timeout\\":60}" }
      [wire] usage.record           { "model": "mock-model", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated   { "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice         { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will ask first." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] requestApproval        { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run Bash, then listen"
    `);
    expect(ctx.llmCalls).toHaveLength(1);

    await ctx.rpc.steer({ input: [{ type: 'text', text: 'Also mention the steer.' }] });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[]`);

    ctx.mockNextResponse({ type: 'text', text: 'Approved, and I saw the steer.' });
    approval.respond({
      decision: 'approved',
      selectedLabel: 'approve',
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [wire] context.splice                      { "start": 1, "deleteCount": 1, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will ask first." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf approved\\",\\"timeout\\":60}" } ] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 2, "tokens": 29, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 29 }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress                       { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "approved" } }
      [wire] context.splice                      { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "approved" } ], "toolCalls": [], "toolCallId": "call_bash" } ], "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "approved" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] context.splice                      { "start": 3, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Also mention the steer." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "Approved, and I saw the steer." }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice                      { "start": 4, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "Approved, and I saw the steer." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 5, "tokens": 50, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 50 }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will ask first."  calls call_bash:Bash { "command": "printf approved", "timeout": 60 }
        tool[call_bash]: text "approved"
        user: text "Also mention the steer."
    `);
    expect(ctx.llmCalls).toHaveLength(2);
    await ctx.expectResumeMatches();
  });

  it('rejects a non-steer prompt while a turn is active', async () => {
    const ctx = testAgent(kaosServices(createCommandKaos('should-not-run')));
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will wait for approval.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the active turn' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] context.splice         { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start the active turn" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] turn.launch            { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started           { "turnId": 0, "origin": { "kind": "user" } }
      [emit] turn.step.started      { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta        { "turnId": 0, "delta": "I will wait for approval." }
      [emit] tool.call.delta        { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] usage.record           { "model": "mock-model", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated   { "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice         { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will wait for approval." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] requestApproval        { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Start the active turn"
    `);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'This should not start a new turn' }] });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`[emit] error   { "code": "turn.agent_busy", "message": "Cannot launch a new turn while another turn (ID 0) is active", "details": { "turnId": 0 }, "retryable": true }`);
    ctx.mockNextResponse({ type: 'text', text: 'I will not run it.' });
    approval.respond({
      decision: 'rejected',
      selectedLabel: 'reject',
    });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "result": { "decision": "rejected", "selectedLabel": "reject" }, "time": "<time>" }
      [wire] context.splice                      { "start": 1, "deleteCount": 1, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will wait for approval." } ], "toolCalls": [ { "type": "function", "id": "call_bash", "name": "Bash", "arguments": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" } ] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 2, "tokens": 32, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 32 }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.splice                      { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "<system>ERROR: Tool execution failed.</system>\\nTool \\"Bash\\" was not run because the user rejected the approval request." } ], "toolCalls": [], "toolCallId": "call_bash", "isError": true } ], "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "Tool \\"Bash\\" was not run because the user rejected the approval request.", "isError": true }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "I will not run it." }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 63, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 70, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 70, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 70, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice                      { "start": 3, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will not run it." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured               { "length": 4, "tokens": 71, "time": "<time>" }
      [emit] agent.status.updated                { "contextTokens": 71 }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 63, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    await ctx.expectResumeMatches();
  });
});

const abortableGenerate: GenerateFn = async (
  _chat,
  _systemPrompt,
  _tools,
  _history,
  _callbacks,
  options,
) => {
  await new Promise<void>((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options?.signal?.aborted === true) {
      rejectAbort();
      return;
    }
    options?.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  throw new Error('abortableGenerate unexpectedly completed');
};

function eventIndex(
  ctx: Pick<ReturnType<typeof testAgent>, 'allEvents'>,
  type: string,
  event: string,
): number {
  return ctx.allEvents.findIndex((entry) => entry.type === type && entry.event === event);
}

function bashCall(): ToolCall {
  return bashCallWithId('call_bash', 'printf should-not-run');
}

function bashCallWithId(id: string, command: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

function agentSwarmCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_swarm',
    name: 'AgentSwarm',
    arguments: JSON.stringify({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    }),
  };
}

function mockSubagentHost<T extends Partial<SessionSubagentHost>>(
  host: T,
): T & SessionSubagentHost {
  return { spawn: vi.fn(), resume: vi.fn(), runQueued: vi.fn(), ...host } as unknown as T &
    SessionSubagentHost;
}

interface ApiErrorTelemetryCase {
  readonly name: string;
  readonly createError: () => Error;
  readonly errorType: string;
  readonly statusCode?: number;
}

function singleAttemptAgentOptions(): Pick<TestAgentOptions, 'initialConfig'> {
  return {
    initialConfig: {
      providers: {},
      loopControl: { maxRetriesPerStep: 1 },
    },
  };
}

const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

const DEFAULT_MEDIA_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: MP4_HEADER.length,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

function createExecKaos(output: string): {
  readonly kaos: Kaos;
  readonly execWithEnv: NonNullable<Kaos['execWithEnv']>;
} {
  const execWithEnv = vi.fn<NonNullable<Kaos['execWithEnv']>>(async () => ({
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as KaosProcess['stdin'],
    stdout: Readable.from([output]),
    stderr: Readable.from(['']),
    pid: 42,
    exitCode: 0,
    wait: vi.fn().mockResolvedValue(0),
    kill: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  }));
  return { kaos: createFakeKaos({ execWithEnv }), execWithEnv };
}

function createVideoKaos(): Kaos {
  return createFakeKaos({
    stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_MEDIA_STAT),
    readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function mediaCapabilities(): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 1_000_000,
  };
}

function oauthAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
  capabilities?: readonly string[] | undefined,
): {
  readonly initialConfig: TestAgentOptions['initialConfig'];
  readonly services: TestAgentServiceOverride;
} {
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
          capabilities: capabilities === undefined ? undefined : [...capabilities],
        },
      },
    },
    services: coreServices((reg) => {
      reg.definePartialInstance(IOAuthService, {
        resolveTokenProvider: () => ({ getAccessToken }),
      });
    }),
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-oauth-retry',
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
