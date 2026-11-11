import { getMaxListeners } from 'node:events';

import { type ToolCall } from '@moonshot-ai/core/llm/message';
import { emptyUsage } from '@moonshot-ai/core/llm/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { Event } from '#/_base/event';
import type { LoopRequester } from '#/agent/loop/requesterContract';
import type { AgentLoopRequestFactory } from '#/agent/loop/requester';
import type { AgentLoopRequestObserver } from '#/agent/loop/requestObservation';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import {
  IAgentLifecycleService,
  type AgentScopeCreatedEvent,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  AssistantDelta,
  ThinkingDelta,
  TurnStarted,
  TurnStepInterrupted,
  TurnStepStarted,
} from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import type { ExecutableTool } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { abortedToolOutput, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';

import {
  agentService,
  appService,
  createTestAgent,
  InMemoryWireRecordPersistence,
  permissionModeServices,
  createMockProvider,
  createMockProviderRequester,
  providerHttpError,
  sessionService,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { stubPluginService } from '../../app/plugin/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { submitPromptTurn } from './stubs';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

function trackStepReasons(ctx: TestAgentContext): readonly (string | undefined)[] {
  const reasons: (string | undefined)[] = [];
  const factory = (ctx.get(IAgentLoopService) as unknown as {
    requestFactory: AgentLoopRequestFactory;
  }).requestFactory;
  const observer = (factory as unknown as { observer: AgentLoopRequestObserver }).observer;
  const recordAttempt = observer.recordAttempt.bind(observer);
  vi.spyOn(observer, 'recordAttempt').mockImplementation((observation, request, ledger) => {
    const header = request.endpoint?.headers?.['X-Msh-Client-Metadata'];
    reasons.push(header === undefined ? undefined : JSON.parse(header).step_reason);
    recordAttempt(observation, request, ledger);
  });
  return reasons;
}

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentLoopService;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentLoopService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse(
      { type: 'think', think: '<think-1>', reasoningKey: 'reasoning_content' },
      { type: 'text', text: '<text-1>' },
      { type: 'think', think: '' },
      { type: 'text', text: '<text-2>' },
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "model": "mock-model", "thinkingEffort": "off", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools      { "agentId": "main", "names": [], "time": "<time>" }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>" }
      [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal", "time": "<time>" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal" }
      [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
      [wire] tool_select.initialized     { "agentId": "main", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "ReadMediaFile", "select_tools", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [emit] thinking.delta              { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<think-1>", "block": 0 }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<text-1>", "block": 1 }
      [emit] thinking.delta              { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<text-2>", "block": 1 }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "think", "think": "<think-1>", "reasoningKey": "reasoning_content" }, { "type": "text", "text": "<text-1><text-2>" } ], "toolCalls": [], "providerMessageId": "mock-1", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 13 }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 0, "part": { "type": "think", "think": "<think-1>", "reasoningKey": "reasoning_content" }, "startedAt": "<time>" }, "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 1, "part": { "type": "text", "text": "<text-1><text-2>" }, "startedAt": "<time>" }, "time": "<time>" }
      [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
    messages:
      user: text "Hello"
  `);
  });

  it('persists a turn.ended wire record with the end reason and duration', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed' });
    expect(record?.['durationMs']).toEqual(expect.any(Number));
    expect(record?.['time']).toEqual(expect.any(Number));
  });

  it('restores the engine turn clock from the machine journal on resume', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    const records = await ctx.persistedWireRecords();
    expect(records.some((record) => record.type === 'turn.ended')).toBe(true);

    const resumed = createTestAgent(
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(records)),
    );
    try {
      await resumed.restorePersisted();
      const turnIds: number[] = [];
      const subscription = resumed
        .get(IEventBus)
        .subscribe(TurnStarted, (event) => turnIds.push(event.turnId));
      resumed.mockNextResponse({ type: 'text', text: 'second answer' });
      await resumed.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
      await resumed.untilTurnEnd();
      subscription.dispose();

      expect(turnIds).toEqual([1]);
      const persisted = await resumed.persistedWireRecords();
      expect(
        persisted
          .filter((record) => record.type === 'turn.ended')
          .map((record) => record['turnId']),
      ).toEqual([0, 1]);
    } finally {
      await resumed.dispose();
    }
  });

  it('fails the turn after a filtered step completes', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "model": "mock-model", "thinkingEffort": "off", "maxContextTokens": 1000000 }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>" }
      [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal", "time": "<time>" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal" }
      [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
      [wire] tool_select.initialized     { "agentId": "main", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "ReadMediaFile", "select_tools", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "blocked", "block": 0 }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "blocked" } ], "toolCalls": [], "providerMessageId": "mock-1", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "filtered", "providerFinishReason": "filtered", "rawFinishReason": "content_filter" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 8 }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 0, "part": { "type": "text", "text": "blocked" }, "startedAt": "<time>" }, "time": "<time>" }
      [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [wire] token_counting.measured     { "agentId": "main", "length": 2, "tokens": 8, "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "interruptReason": "filtered" }
    `);

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'filtered',
    });
  });

  it('marks a completed turn as truncated when the provider stops at max tokens', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    const { turn } = submitTurn(loop, 'Hello');
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: true,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'max_tokens',
      providerFinishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed' });
  });

  it('stops the turn when provider reports tool_calls without any tool call structure', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'tool_calls',
    });

    const { turn } = submitTurn(loop, 'Hello');
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'other',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
  });

  it('lets a loop error handler recover a non-context loop error by retrying', async () => {
    profile.update({ activeToolNames: [] });
    const workTool: ExecutableTool = {
      name: 'Work',
      description: 'Pretend to work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Work',
        execute: async () => ({ output: 'should never run' }),
      }),
    };
    ctx.get(IAgentToolRegistryService).register(workTool);
    const seenErrors: Array<{ readonly step: number | undefined; readonly message: string }> = [];

    loop.registerLoopErrorHandler({
      id: 'test-recover-generate-error',
      match: () => true,
      handle: async (hookCtx) => {
        seenErrors.push({
          step: hookCtx.step,
          message: toErrorMessage(hookCtx.error),
        });
        if (seenErrors.length === 1) {
          ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
          hookCtx.retry();
          return true;
        }
        return undefined;
      },
    });

    ctx.mockNextProviderResponse(providerHttpError(400, 'Unexpected generate call #1'));
    const reasons = trackStepReasons(ctx);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
    ]);
    expect(reasons).toEqual(['turn_start', 'turn_start']);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );

    profile.update({ activeToolNames: ['Work'] });
    const beforeExecuteError = new Error('beforeExecute blew up');
    const subscription = ctx.get(IAgentToolExecutorService).registerLegacyStarting(() => {
      throw beforeExecuteError;
    });
    ctx.mockNextResponse(
      { type: 'text', text: 'working' },
      { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the tool' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
      { step: 1, message: 'beforeExecute blew up' },
    ]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({ message: 'beforeExecute blew up' }),
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(ctx.allEvents).toContainEqual(
        expect.objectContaining({
          type: '[wire]',
          event: 'context.append_loop_event',
          args: expect.objectContaining({
            event: expect.objectContaining({ type: 'step.end', finishReason: 'error' }),
          }),
        }),
      );
    });
    expect(
      ctx.allEvents.filter(
        (entry) =>
          entry.type === '[wire]' &&
          entry.event === 'context.append_loop_event' &&
          ['tool.call', 'tool.result'].includes(
            (entry.args as { event?: { type?: string } }).event?.type ?? '',
          ),
      ),
    ).toHaveLength(0);
    expect(
      ctx.allEvents.filter(
        (entry) => entry.type === '[rpc]' && ['tool.call.started', 'tool.result'].includes(entry.event),
      ),
    ).toHaveLength(0);
    expect(ctx.contextData().history.some((message) => message.role === 'tool')).toBe(false);
    expect(
      ctx.contextData().history.every((message) => message.role !== 'assistant' || message.toolCalls.length === 0),
    ).toBe(true);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('reports an untyped LLM error message without an internal-code prefix', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse(providerHttpError(400, 'Unexpected generate call #1'));

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.interrupted',
        args: expect.objectContaining({
          reason: 'error',
          message: 'Unexpected generate call #1',
        }),
      }),
    );
  });

  it('appends every failed attempt partial when a retried request fails mid-stream', async () => {
    const local = createTestAgent({
      initialConfig: { providers: {}, loopControl: { maxAttemptsPerStep: 2 } },
    });
    try {
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first attempt partial' }],
        usage: { inputOther: 7, output: 3 },
        ...providerHttpError(429, 'retry', { retryAfterMs: 1 }),
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'final attempt partial' }],
        usage: { inputOther: 11, output: 5 },
        error: new Error('stream broke mid-flight'),
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(2);
      expect(local.contextData().history).toContainEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'final attempt partial' }],
        providerMessageId: 'mock-2',
        toolCalls: [],
        usage: { inputOther: 11, output: 5, inputCacheCreation: 0, inputCacheRead: 0 },
      });
      expect(local.contextData().history).toContainEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'first attempt partial' }],
        providerMessageId: 'mock-1',
        toolCalls: [],
        usage: { inputOther: 7, output: 3, inputCacheCreation: 0, inputCacheRead: 0 },
      });
      expect(local.allEvents).toContainEqual(
        expect.objectContaining({
          event: 'turn.step.interrupted',
          args: expect.objectContaining({ reason: 'error', message: 'Error: stream broke mid-flight' }),
        }),
      );
      const endedSteps = (await local.persistedWireRecords()).filter((record) =>
        record.type === 'context.append_loop_event' && (record['event'] as { type?: string }).type === 'step.end',
      );
      expect(endedSteps.map((record) => (record['event'] as { usage?: unknown }).usage)).toMatchObject([
        { inputOther: 7, output: 3 },
        { inputOther: 11, output: 5 },
      ]);

      const cancelling = createTestAgent({ initialConfig: { providers: {}, loopControl: { maxAttemptsPerStep: 2 } } });
      try {
        cancelling.mockNextProviderResponse({
          parts: [{ type: 'text', text: 'cancel partial' }],
          ...providerHttpError(429, 'retry', { retryAfterMs: 60_000 }),
        });
        const { turn } = submitTurn(cancelling.get(IAgentLoopService), 'Cancel during backoff');
        await cancelling.once('turn.step.retrying');
        expect(cancelling.get(IAgentLoopService).snapshot().turn?.retry).toMatchObject({ nextAttempt: 2 });
        turn.cancel(new Error('stop during backoff'));
        await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
        const partials = cancelling.contextData().history.filter((message) =>
          message.role === 'assistant' && message.content.some((part) => part.type === 'text' && part.text.includes('cancel partial')),
        );
        expect(partials).toHaveLength(1);
      } finally {
        await cancelling.dispose();
      }
    } finally {
      await local.dispose();
    }
  });

  it('does not run loop error handlers for aborted turns', async () => {
    let called = false;
    loop.registerLoopErrorHandler({
      id: 'test-abort-not-recoverable',
      match: () => {
        called = true;
        return true;
      },
      handle: async () => undefined,
    });
    const { turn } = submitTurn(loop, 'go');
    turn.cancel(new Error('stop'));

    const result = await turn.result;

    expect(result.type).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('fails with the error handler error when recovery throws', async () => {
    const recoveryError = new Error('recovery failed');
    loop.registerLoopErrorHandler({
      id: 'test-throw-recovery-error',
      match: () => true,
      handle: async () => {
        throw recoveryError;
      },
    });

    ctx.mockNextProviderResponse(providerHttpError(400, 'Unexpected generate call #1'));
    const { turn } = submitTurn(loop, 'go');
    const result = await turn.result;

    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.error).toBe(recoveryError);
    }
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
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
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);
    const reasons = trackStepReasons(ctx);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "model": "mock-model", "thinkingEffort": "off", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools          { "agentId": "main", "names": [ "Lookup" ], "time": "<time>" }
      [emit] prompt.submitted                { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>" }
      [wire] turn.prompt                     { "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal", "time": "<time>" }
      [emit] context.spliced                 { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
      [wire] context.append_message          { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] turn.prompt                     { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "trigger": "normal" }
      [emit] turn.started                    { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Look up moon" }
      [emit] prompt.started                  { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [emit] turn.step.started               { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] plugin.session_start            { "agentId": "main", "content": null, "time": "<time>" }
      [wire] tool_select.initialized         { "agentId": "main", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Lookup", "Read", "ReadMediaFile", "select_tools", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-2>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "ExitPlanMode", "FetchURL", "GetGoal", "Glob", "Grep", "Read", "SetGoalBudget", "Skill", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "Write" ], "time": "<time>" }
      [emit] assistant.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will look it up.", "block": 0 }
      [emit] tool.call.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [emit] context.spliced                 { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ], "providerMessageId": "mock-1", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "contextTokens": 20 }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "block": 0, "part": { "type": "text", "text": "I will look it up." }, "startedAt": "<time>" }, "time": "<time>" }
      [wire] usage.record                    { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [wire] token_counting.measured         { "agentId": "main", "length": 2, "tokens": 20, "time": "<time>" }
      [emit] permission.approval.requested   { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" } }
      [wire] interaction.request             { "agentId": "main", "id": "<approval-1>", "kind": "approval", "toolCallId": "call_lookup", "request": { "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }, "time": "<time>" }
      [emit] requestApproval                 { "id": "<approval-1>", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
    messages:
      user: text "Look up moon"
  `);

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] interaction.resolved                { "agentId": "main", "id": "<approval-1>", "response": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [emit] permission.approval.resolved        { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" }, "decision": "approved", "selectedLabel": "approve" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "result": { "decision": "approved", "selectedLabel": "approve" }, "agentId": "main", "time": "<time>" }
      [emit] tool.call.started                   { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [emit] tool.updated                        { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "taskId": "<taskId>", "status": "running", "detached": false, "fields": {} }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-4>", "turnId": "0", "step": 1, "stepUuid": "<uuid-2>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.updated                        { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "taskId": "<taskId>", "status": "running", "detached": false, "fields": {} }
      [emit] tool.updated                        { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "taskId": "<taskId>", "status": "success", "detached": false, "fields": {} }
      [emit] tool.result                         { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
      [emit] turn.step.completed                 { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [emit] context.spliced                     { "time": "<time>", "agentId": "main", "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "lookup-result" } ], "toolCallId": "call_lookup" } ] }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-4>", "toolCallId": "call_lookup", "result": { "output": "lookup-result" } }, "time": "<time>" }
      [emit] turn.step.started                   { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] assistant.delta                     { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The lookup result is lookup-result.", "block": 0 }
      [emit] context.spliced                     { "time": "<time>", "agentId": "main", "start": 3, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is lookup-result." } ], "toolCalls": [], "providerMessageId": "mock-2", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } ] }
      [emit] turn.step.completed                 { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-5>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.status.updated                { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated                { "time": "<time>", "agentId": "main", "contextTokens": 37 }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "0", "step": 2, "stepUuid": "<uuid-6>", "block": 0, "part": { "type": "text", "text": "The lookup result is lookup-result." }, "startedAt": "<time>" }, "time": "<time>" }
      [wire] usage.record                        { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [wire] token_counting.measured             { "agentId": "main", "length": 4, "tokens": 37, "time": "<time>" }
      [emit] turn.ended                          { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "lookup-result"
    `);
    expect(reasons).toEqual(['turn_start', 'tool_results']);
  });

  it('does not abort sibling tools when a parallel batch tool completes first', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    const slowGate = deferred();
    try {
      const slowStarted = deferred();
      let slowSawAbort: boolean | undefined;
      const fastTool: ExecutableTool = {
        name: 'Fast',
        description: 'Return immediately.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Fast',
          execute: async () => ({ output: 'fast result' }),
        }),
      };
      const slowTool: ExecutableTool = {
        name: 'Slow',
        description: 'Wait on a gate before returning.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Slow',
          execute: async ({ signal }) => {
            slowStarted.resolve();
            await slowGate.promise;
            slowSawAbort = signal.aborted;
            return { output: 'slow result' };
          },
        }),
      };
      await local.restorePersisted();
      local.get(IAgentLoopService).update({ activeToolNames: ['Fast', 'Slow'] });
      local.get(IAgentToolRegistryService).register(fastTool);
      local.get(IAgentToolRegistryService).register(slowTool);

      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-fast-1', name: 'Fast', arguments: '{}' },
        { type: 'function', id: 'call-slow-1', name: 'Slow', arguments: '{}' },
      );
      local.mockNextResponse({ type: 'text', text: 'all done' });

      const toolResults = (): Array<Extract<LoopRecordedEvent, { type: 'tool.result' }>> =>
        local.allEvents
          .filter(
            (entry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event',
          )
          .map((entry) => (entry.args as { event: LoopRecordedEvent }).event)
          .filter(
            (event): event is Extract<LoopRecordedEvent, { type: 'tool.result' }> =>
              event.type === 'tool.result',
          );

      const { turn } = submitTurn(local.get(IAgentLoopService), 'use both tools');
      await slowStarted.promise;
      await vi.waitFor(() => {
        expect(toolResults().some((event) => event.toolCallId === 'call-fast-1')).toBe(true);
      });
      slowGate.resolve();
      await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

      expect(slowSawAbort).toBe(false);
      expect(toolResults().map((event) => event.toolCallId).toSorted()).toEqual([
        'call-fast-1',
        'call-slow-1',
      ]);
      await local.expectResumeMatches();
    } finally {
      slowGate.resolve();
      await local.dispose();
    }
  });

  it('forwards the cancellation reason to the signals of running tools', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      const started = deferred();
      const signals: AbortSignal[] = [];
      const hangTool: ExecutableTool = {
        name: 'Hang',
        description: 'Wait until aborted.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Hang',
          execute: ({ signal }) => {
            signals.push(signal);
            started.resolve();
            return new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        }),
      };
      local.get(IAgentLoopService).update({ activeToolNames: ['Hang'] });
      local.get(IAgentToolRegistryService).register(hangTool);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-hang-1', name: 'Hang', arguments: '{}' },
      );

      const loop = local.get(IAgentLoopService);
      const { turn } = submitTurn(loop, 'hang until cancelled');
      await started.promise;

      expect(loop.cancel()).toBe(true);
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(isUserCancellation(signals[0]?.reason)).toBe(true);
    } finally {
      await local.dispose();
    }
  });

  it('records the output a stopped tool produced before it was interrupted', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      const started = deferred();
      const streamTool: ExecutableTool = {
        name: 'Stream',
        description: 'Stream until aborted.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Stream',
          execute: ({ signal }) => {
            started.resolve();
            return new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => resolve({ output: 'line-1\nInterrupted by user', isError: true }),
                { once: true },
              );
            });
          },
        }),
      };
      const hangTool: ExecutableTool = {
        name: 'Hang',
        description: 'Wait until aborted.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Hang',
          execute: ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        }),
      };
      local.get(IAgentLoopService).update({ activeToolNames: ['Stream', 'Hang'] });
      local.get(IAgentToolRegistryService).register(streamTool);
      local.get(IAgentToolRegistryService).register(hangTool);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-stream-1', name: 'Stream', arguments: '{}' },
        { type: 'function', id: 'call-hang-1', name: 'Hang', arguments: '{}' },
      );

      const loop = local.get(IAgentLoopService);
      const { turn } = submitTurn(loop, 'stream until cancelled');
      await started.promise;
      expect(loop.cancel()).toBe(true);
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      const outputs = Object.fromEntries(
        local.allEvents
          .filter((entry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event')
          .map((entry) => (entry.args as { event: LoopRecordedEvent }).event)
          .filter((event): event is Extract<LoopRecordedEvent, { type: 'tool.result' }> => event.type === 'tool.result')
          .map((event) => [event.toolCallId, event.result.output]),
      );
      expect(outputs['call-stream-1']).toBe('line-1\nInterrupted by user');
      expect(outputs['call-hang-1']).toBe(abortedToolOutput('Hang', userCancellationReason()));
    } finally {
      await local.dispose();
    }
  });


  it('preserves tool call extras (Gemini thought_signature) through to context', async () => {
    const sigCall: ToolCall = {
      type: 'function',
      id: 'call_sig',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
      extras: { thought_signature_b64: 'c2lnbmF0dXJl' },
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
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
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, sigCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    const assistant = ctx.contextData().history.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: 'c2lnbmF0dXJl' });
  });

  it('lets non-external stop hooks launch follow-up turns more than once', async () => {
    profile.update({ activeToolNames: [] });
    let continuations = 0;
    loop.hooks.onDidFinishStep.register('test-repeat-stop-continuation', async (hookCtx, next) => {
      if (continuations < 2) {
        continuations += 1;
        loop.notify({
          message: {
            role: 'user',
            content: [{ type: 'text', text: `continue ${continuations}` }],
            origin: { kind: 'system_trigger', name: 'stop_hook' },
          },
        });
        return;
      }
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Third answer.' });
    const reasons = trackStepReasons(ctx);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await loop.settled();

    expect(continuations).toBe(2);
    expect(ctx.llmCalls).toHaveLength(3);
    expect(reasons).toEqual(['turn_start', 'turn_start', 'turn_start']);
    const startedSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.started')
      .map((event) => (event.args as { step: number }).step);
    expect(startedSteps).toEqual([1, 1, 1]);
    const retryingSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.retrying')
      .map((event) => (event.args as { step: number }).step);
    expect(retryingSteps).toEqual([]);
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 1' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 2' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
  });

  it('keeps the terminal real 503 after an earlier real 429', async () => {
    const local = createTestAgent({
      initialConfig: { providers: {}, loopControl: { maxAttemptsPerStep: 2 } },
    });
    try {
      local.mockNextProviderResponse(
        providerHttpError(429, 'first attempt rate limited', {
          requestId: 'req-first-429',
          retryAfterMs: 1,
          traceId: 'trace-first-429',
        }),
      );
      local.mockNextProviderResponse(
        providerHttpError(503, 'final attempt unavailable', {
          requestId: 'req-final-503',
          traceId: 'trace-final-503',
        }),
      );

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      const retries = local.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.retrying',
      );
      expect(retries).toHaveLength(1);
      expect(retries[0]?.args).toMatchObject({
        failedAttempt: 1,
        nextAttempt: 2,
        errorMessage: 'first attempt rate limited',
        statusCode: 429,
      });
      const started = local.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.started',
      );
      expect(started.map((event) => (event.args as { step: number }).step)).toEqual([1, 1]);
      expect((started[0]?.args as { stepId?: string }).stepId).toBe((started[1]?.args as { stepId?: string }).stepId);
      expect(local.allEvents.indexOf(retries[0]!)).toBeLessThan(local.allEvents.indexOf(started[1]!));
      const ended = local.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'turn.ended',
      );
      expect(ended?.args).toMatchObject({
        reason: 'failed',
        error: {
          code: 'provider.api_error',
          name: 'APIStatusError',
          message: 'final attempt unavailable',
          details: {
            statusCode: 503,
            requestId: 'req-final-503',
            traceId: 'trace-final-503',
          },
        },
      });
      expect((ended?.args as TurnEnded).error?.details).toEqual({
        statusCode: 503,
        requestId: 'req-final-503',
        traceId: 'trace-final-503',
      });
    } finally {
      await local.dispose();
    }
  });

  it('raises the abort-listener ceiling on the step signal for parallel tool bursts', async () => {
    profile.update({ activeToolNames: [] });
    let observed = 0;
    loop.hooks.onDidFinishStep.register('test-step-signal-listener-ceiling', async (hookCtx, next) => {
      observed = getMaxListeners(hookCtx.signal);
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(observed).toBe(64);
  });

  it('ends the turn when an afterStep hook sets stopTurn even though the model requested tool calls', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
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
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    const afterSteps: number[] = [];
    loop.hooks.onDidFinishStep.register('test-stop-turn', async (hookCtx, next) => {
      afterSteps.push(hookCtx.step);
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    const { turn } = submitTurn(loop, 'Look up moon');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(afterSteps).toEqual([1]);
    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('runs a queued notify in a new turn after stopTurn', async () => {
    profile.update({ activeToolNames: [] });

    loop.hooks.onDidFinishStep.register('test-continue-like-stop-hook', async (hookCtx, next) => {
      if (hookCtx.turnId === 0) loop.notify();
      await next();
    });
    loop.hooks.onDidFinishStep.register('test-hard-stop', async (hookCtx, next) => {
      if (hookCtx.turnId === 0) hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Notify answer.' });

    const { turn } = submitTurn(loop, 'hello');
    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('carries a tool stopTurnReason into the completed turn result and turn.ended', async () => {
    const stopCall: ToolCall = {
      type: 'function',
      id: 'call_stop',
      name: 'Stopper',
      arguments: '{}',
    };
    const stopperTool: ExecutableTool<Record<string, never>> = {
      name: 'Stopper',
      description: 'Stops the turn with a reason.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Stopper',
        execute: async () => ({ output: 'stopped', stopTurn: true, stopTurnReason: 'demo_reason' }),
      }),
    };
    profile.update({ activeToolNames: ['Stopper'] });
    ctx.get(IAgentToolRegistryService).register(stopperTool);

    ctx.mockNextResponse({ type: 'text', text: 'Stopping.' }, stopCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    const { turn } = submitTurn(loop, 'stop');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
      stopReason: 'demo_reason',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed', stopReason: 'demo_reason' });
    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed', stopReason: 'demo_reason' });
  });

  it('queues consecutive nextTurn requests in FIFO order without overlapping turns', async () => {
    const events: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => {
      if (event instanceof TurnStarted || event instanceof TurnEnded) {
        events.push(`${event.type}:${event.turnId}`);
      }
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = submitTurn(loop, 'first').turn;
    const second = submitTurn(loop, 'second').turn;
    const third = submitTurn(loop, 'third').turn;
    loop.notify();

    await Promise.all([first.result, second.result, third.result]);
    await loop.settled();
    subscription.dispose();

    const startedSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.started')
      .map((event) => event.args as { turnId: number; step: number });
    expect(startedSteps).toMatchObject([
      { turnId: 0, step: 1 },
      { turnId: 3, step: 1 },
    ]);
    expect(first.id).toBe(0);
    expect(second.id).toBe(1);
    expect(third.id).toBe(2);
    await expect(first.result).resolves.toMatchObject({ type: 'completed', steps: 1 });
    await expect(second.result).resolves.toMatchObject({ type: 'completed', steps: 0, stopReason: 'prompt_only' });
    await expect(third.result).resolves.toMatchObject({ type: 'completed', steps: 0, stopReason: 'prompt_only' });
    expect(events).toEqual([
      'turn.started:0',
      'turn.ended:0',
      'turn.started:1',
      'turn.ended:1',
      'turn.started:2',
      'turn.ended:2',
      'turn.started:3',
      'turn.ended:3',
    ]);
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('takes a non-pausing history snapshot while a turn runs to natural completion', async () => {
    let started!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-quiescence', async (_hookCtx, next) => {
      started();
      await canFinish;
      await next();
    });

    const active = submitTurn(loop, 'active').turn;
    await activeStarted;

    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const snapshot = loop.tryAcquireHistorySnapshot();
    expect(snapshot).toBeDefined();
    expect(loop.tryAcquireHistorySnapshot()).toBeUndefined();
    expect(loop.snapshot().paused).toBe(false);
    expect(active.signal.aborted).toBe(false);

    ctx.mockNextResponse({ type: 'text', text: 'completed normally' });
    release();
    await expect(active.result).resolves.toMatchObject({ type: 'completed' });
    expect(loop.tryAcquireQuiescence()).toBeUndefined();

    snapshot?.dispose();
    const quiescence = loop.tryAcquireQuiescence();
    expect(quiescence).toBeDefined();
    quiescence?.dispose();
    hook.dispose();
  });

  it('holds new admissions until an idle quiescence lease is released', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const held = submitTurn(loop, 'held').turn;
    let started = false;
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, () => {
      started = true;
    });

    await Promise.resolve();
    expect(started).toBe(false);
    expect(held.state).toBe('queued');
    expect(loop.snapshot()).toMatchObject({ state: 'idle', hasPendingRequests: true });

    ctx.mockNextResponse({ type: 'text', text: 'after undo' });
    lease?.dispose();
    await expect(held.result).resolves.toMatchObject({ type: 'completed' });
    subscription.dispose();

    const parked = createTestAgent(sessionService(IAgentLifecycleService, parkedLifecycleStub()));
    try {
      const parkedLoop = parked.get(IAgentLoopService);
      const early = submitTurn(parkedLoop, 'early').turn;
      expect(parkedLoop.snapshot()).toMatchObject({ state: 'idle', hasPendingRequests: true });
      expect(parked.llmCalls).toHaveLength(0);

      const earlyQueueId = parkedLoop.snapshot().queue[0]!.meta!.promptId!;
      expect(parkedLoop.cancel({ promptId: earlyQueueId }, new Error('not wanted'))).toBe(true);
      await expect(early.result).resolves.toMatchObject({ type: 'cancelled' });

      const real = submitTurn(parkedLoop, 'real').turn;
      let nudgeConsumed = 0;
      parkedLoop.notify({
        message: { role: 'user', content: [{ type: 'text', text: 'nudge text' }] },
        onConsume: () => {
          nudgeConsumed += 1;
        },
      });
      parked.mockNextResponse({ type: 'text', text: 'real answer' });
      await expect(real.result).resolves.toMatchObject({ type: 'completed' });
      expect(nudgeConsumed).toBe(1);
      expect(parked.llmCalls).toHaveLength(1);
      expect(parked.contextData().history).toContainEqual(
        expect.objectContaining({
          content: [{ type: 'text', text: 'nudge text' }],
        }),
      );
    } finally {
      await parked.dispose();
    }
  });

  it('can abort an admission while quiescence holds it', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = submitTurn(loop, 'held').turn;
    const resumed = submitTurn(loop, 'resumed').turn;

    expect(held.cancel()).toBe(true);
    await expect(held.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    expect(loop.snapshot().hasPendingRequests).toBe(true);

    ctx.mockNextResponse({ type: 'text', text: 'resumed answer' });
    lease?.dispose();
    await expect(resumed.result).resolves.toMatchObject({ type: 'completed', steps: 1 });
    expect(loop.snapshot().hasPendingRequests).toBe(false);
    expect(loop.snapshot().state).toBe('idle');
  });

  it('preserves explicit queue semantics across programmatic and user cancellation', async () => {
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    let armed = true;
    loop.hooks.onWillBeginStep.register('test-turn-cancel-mid-step', async (hookCtx, next) => {
      if (armed) {
        armed = false;
        stepStarted();
        await Promise.race([
          running,
          new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
          }),
        ]);
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'after cancellation' });

    const turn = submitTurn(loop, 'start').turn;
    const queued = submitTurn(loop, 'next').turn;
    await started;

    expect(turn.cancel(new Error('skip this turn'))).toBe(true);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    releaseRunning();
    await expect(queued.result).resolves.toMatchObject({ type: 'completed', steps: 1 });

    expect(queued.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);

    const local = createTestAgent(permissionModeServices('yolo'));
    await local.restorePersisted();
    const localLoop = local.get(IAgentLoopService);
    let releaseActive!: () => void;
    const activeRunning = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let activeStepStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      activeStepStarted = resolve;
    });
    let blockActive = true;
    localLoop.hooks.onWillBeginStep.register('test-user-cancel-holds-internal-work', async (hookCtx, next) => {
      if (blockActive) {
        blockActive = false;
        activeStepStarted();
        await Promise.race([
          activeRunning,
          new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
          }),
        ]);
      }
      await next();
    });
    try {
      const active = submitTurn(localLoop, 'active').turn;
      const skill = submitPromptTurn(localLoop, {
        message: { role: 'user', content: [{ type: 'text', text: 'skill continuation' }] },
        meta: { origin: {
          kind: 'skill_activation',
          activationId: 'act_queued',
          skillName: 'queued-skill',
          trigger: 'model-tool',
        } as PromptOrigin },
      }).turn;
      const explicit = submitPromptTurn(localLoop, {
        message: { role: 'user', content: [{ type: 'text', text: 'explicitly queued' }] },
        meta: { origin: { kind: 'user' } },
      }).turn;
      await activeStarted;

      local.mockNextResponse({ type: 'text', text: 'explicit answer' });
      expect(active.cancel()).toBe(true);
      await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
      await expect(skill.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
      await expect(explicit.result).resolves.toMatchObject({ type: 'completed' });
      expect(localLoop.snapshot().queue).toHaveLength(0);
      expect(local.llmCalls).toHaveLength(1);
    } finally {
      releaseActive();
      await local.dispose();
    }
  });

  it('disposes active and queued turns with all turns settled and never pumps again', async () => {
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-dispose-loop', async (hookCtx, next) => {
      stepStarted();
      await new Promise<void>((_, reject) => {
        hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), { once: true });
      });
      await next();
    });

    const active = submitTurn(loop, 'active').turn;
    const queued = submitTurn(loop, 'queued').turn;
    const queuedExtra = submitTurn(loop, 'queued-extra').turn;
    await started;

    (loop as IAgentLoopService & { dispose(): void }).dispose();

    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await expect(queuedExtra.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    expect(active.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(ctx.llmCalls).toHaveLength(0);
    expect(() => submitTurn(loop, 'rejected')).toThrow();
  });

  it('cancels a queued turn without starting or materializing its initial request', async () => {
    const started: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      started.push(event.turnId);
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = submitTurn(loop, 'first').turn;
    const cancelledTurn = submitTurn(loop, 'cancelled').turn;
    const third = submitTurn(loop, 'third').turn;

    expect(cancelledTurn.cancel()).toBe(true);
    await expect(cancelledTurn.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await Promise.all([first.result, third.result]);
    subscription.dispose();

    expect(started).toEqual([0, 1]);
    expect(ctx.contextData().history).not.toContainEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'cancelled' }] }),
    );
  });

  it('carries the turn.started prompt for system-triggered turns', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'continued' });
    ctx.mockNextResponse({ type: 'text', text: 'hi there' });

    const system = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'continue the goal' }] },
      meta: { origin: { kind: 'system_trigger', name: 'goal_continuation' } as PromptOrigin },
    }).turn;
    await system.result;
    const user = submitTurn(loop, 'hi').turn;
    await user.result;
    subscription.dispose();

    expect(prompts).toEqual(['continue the goal', 'hi']);
  });

  it('carries the turn.started prompt for subagent system triggers', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'scanned' });

    const subagent = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'scan the repo' }] },
      meta: { origin: { kind: 'system_trigger', name: 'subagent' } as PromptOrigin },
    }).turn;
    await subagent.result;
    subscription.dispose();

    expect(prompts).toEqual(['scan the repo']);
  });

  it('carries kimi-file prompt attachments on turn.started, falling back to the URL file id', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, { message: {
            role: 'user',
            content: [
              {
                type: 'image_url',
                imageUrl: { url: 'kimi-file://file_1', id: 'file_1', name: 'photo.png' },
              },
              {
                type: 'video_url',
                videoUrl: { url: 'kimi-file://file_2', id: 'file_2', name: 'clip.mp4' },
              },
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_3' } },
              {
                type: 'image_url',
                imageUrl: { url: 'kimi-file://file_4', id: 'other' },
              },
              { type: 'image_url', imageUrl: { url: 'https://example.com/no-id.png' } },
              {
                type: 'image_url',
                imageUrl: { url: 'ms://provider-blob', id: 'prov_1' },
              },
              { type: 'text', text: 'look' },
            ],
          }, meta: { origin: { kind: 'user' } } }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1', name: 'photo.png' },
        { kind: 'video', fileId: 'file_2', name: 'clip.mp4' },
        { kind: 'image', fileId: 'file_3' },
      ],
    ]);
  });

  it('carries origin file attachments on turn.started promptAttachments', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, { message: {
            role: 'user',
            content: [
              { type: 'image_url', imageUrl: { url: 'kimi-file://file_1', id: 'file_1' } },
              { type: 'text', text: 'summarize' },
            ],
          }, meta: { origin: {
            kind: 'user',
            attachments: [
              {
                name: 'report.pdf',
                mediaType: 'application/pdf',
                size: 42,
                path: '/data/report.pdf',
              },
            ],
          } as PromptOrigin } }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1' },
        {
          kind: 'file',
          name: 'report.pdf',
          mediaType: 'application/pdf',
          size: 42,
          path: '/data/report.pdf',
        },
      ],
    ]);
  });

  it('carries skill activation file attachments on turn.started promptAttachments', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, { message: {
            role: 'user',
            content: [{ type: 'text', text: 'User activated the skill "check".' }],
          }, meta: { origin: {
            kind: 'skill_activation',
            activationId: 'act_1',
            skillName: 'check',
            trigger: 'user-slash',
            attachments: [
              {
                name: 'note.txt',
                mediaType: 'text/plain',
                size: 21,
                path: '/data/note.txt',
              },
            ],
          } as PromptOrigin } }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [{ kind: 'file', name: 'note.txt', mediaType: 'text/plain', size: 21, path: '/data/note.txt' }],
    ]);
  });

  it('settles the waiter of a notification-seeded turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'seeded answer' });
    loop.notify({
      message: {
        role: 'user',
        id: 'seed-1',
        content: [{ type: 'text', text: 'wake up' }],
      },
    });
    await vi.waitFor(() => {
      expect(loop.promptHandle('seed-1')).toBeDefined();
    });
    await expect(loop.promptHandle('seed-1')!.completion).resolves.toMatchObject({
      state: 'completed',
    });
    await loop.settled();
  });
});

describe('turn telemetry', () => {
  it('emits turn_started and turn_ended with mode and protocol on completion', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: {
          turn_id: 0,
          agent_id: 'main',
          mode: 'agent',
          model: 'mock-model',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
          enabled_plugins: '',
        },
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          duration_ms: expect.any(Number),
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        }),
      });
      expect(records.some((record) => record.event === 'turn_interrupted')).toBe(false);
    } finally {
      await local.dispose();
    }
  });

  it('reports enabled plugins on turn_started and turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent(
      { telemetry: recordingTelemetry(records) },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [], enabledPluginIds: ['alpha', 'zeta'] }),
      ),
    );
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({
          turn_id: 0,
          enabled_plugins: 'alpha,zeta',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          enabled_plugins: 'alpha,zeta',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('keeps turn telemetry aligned with the request config across pre-step changes', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      const localProfile = local.get(IAgentLoopService);
      local.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          maxContextSize: 1_000_000,
        },
      });
      localProfile.update({ activeToolNames: [] });
      localProfile.setThinking('on');
      localLoop.hooks.onWillBeginStep.register('test-change-thinking', async (_ctx, next) => {
        localProfile.setThinking('off');
        await next();
      });
      local.mockNextResponse({ type: 'text', text: 'hi' });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('attaches the latest request request id to turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        requestId: 'trace-turn-1',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          request_id: 'trace-turn-1',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('clears the ambient request id when the turn ends', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        requestId: 'trace-turn-clear',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.get(ITelemetryService).getContext()['request_id']).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('does not reuse the previous step trace when a step hook fails before a request', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      localLoop.hooks.onDidFinishStep.register('test-continue-after-first-step', async (hookCtx, next) => {
        if (hookCtx.step === 1) {
          localLoop.notify();
          return;
        }
        await next();
      });
      localLoop.hooks.onWillBeginStep.register('test-fail-before-second-request', async (hookCtx, next) => {
        if (hookCtx.turnId === 1 && hookCtx.step === 1) throw new Error('before step failed');
        await next();
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        requestId: 'trace-step-1',
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(1);
      const ended = records.filter((record) => record.event === 'turn_ended');
      expect(ended).toHaveLength(2);
      expect(ended[0]?.properties).toMatchObject({ reason: 'completed', request_id: 'trace-step-1' });
      expect(ended[1]?.properties).toMatchObject({ reason: 'failed' });
      expect(ended[1]?.properties?.['request_id']).toBeUndefined();
      expect(records.find((record) => record.event === 'turn_interrupted')?.properties?.['request_id']).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_interrupted with interrupt_reason filtered and turn_ended failed', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        requestId: 'trace-turn-2',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_interrupted',
        properties: expect.objectContaining({
          turn_id: 0,
          at_step: 1,
          mode: 'agent',
          interrupt_reason: 'filtered',
          provider_type: 'kimi',
          protocol: 'openai',
          request_id: 'trace-turn-2',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          mode: 'agent',
          error_type: 'provider.filtered',
          request_id: 'trace-turn-2',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('carries the last step request id on the turn.ended event payload', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        requestId: 'trace-payload-completed',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.requestId).toBe('trace-payload-completed');
      const record = (await local.persistedWireRecords()).find(
        (entry) => entry.type === 'turn.ended',
      );
      expect(record).toMatchObject({ requestId: 'trace-payload-completed' });
    } finally {
      await local.dispose();
    }
  });

  it('carries the in-flight request id on the turn.ended payload when the turn fails', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        requestId: 'trace-payload-failed',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.reason).toBe('failed');
      expect(ended[0]!.requestId).toBe('trace-payload-failed');
    } finally {
      await local.dispose();
    }
  });

  it('clears the in-flight request id on the turn.ended payload when the turn is cancelled', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const generate = createMockProvider(async (_request, signal) => {
      requestStarted();
      const reason = await new Promise<unknown>((resolve) => {
        if (signal.aborted) {
          resolve(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
      });
      return {
        id: null,
        message: { role: 'assistant', content: [], toolCalls: [] },
        usage: null,
        finishReason: null,
        rawFinishReason: null,
        requestId: 'trace-payload-cancelled',
        error: reason,
      };
    });
    const local = createTestAgent({ generate });
    try {
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      const prompt = local.rpc
        .prompt({ input: [{ type: 'text', text: 'Hello' }] })
        .catch(() => undefined);
      await started;
      const turnEnd = local.untilTurnEnd();
      local.get(IAgentLoopService).cancel({ turnId: 0 }, new Error('stop'));
      await turnEnd;
      await prompt;
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.reason).toBe('cancelled');
      expect(ended[0]!.requestId).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('omits the request id on the turn.ended payload when the turn saw none', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'hi' }] });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.requestId).toBeUndefined();
      const record = (await local.persistedWireRecords()).find(
        (entry) => entry.type === 'turn.ended',
      );
      expect(record).not.toHaveProperty('requestId');
    } finally {
      await local.dispose();
    }
  });

  it('does not leak a compaction request request id into the turn.ended payload', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentLoopService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        requestId: 'trace-turn-one',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      local.appendExchange(2, 'old user two', 'old assistant two', 80);
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'Compacted summary.' }],
        requestId: 'trace-compaction',
      });
      expect(local.get(IAgentFullCompactionService).begin({ source: 'manual' })).toBe(true);
      await local.get(IAgentFullCompactionService).compacting?.promise;

      local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'second' }] });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(2);
      expect(ended[0]!.requestId).toBe('trace-turn-one');
      expect(ended[1]!.requestId).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_ended with error_type for an uncoded failure', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) }, permissionModeServices('yolo'));
    try {
      const workTool: ExecutableTool = {
        name: 'Work',
        description: 'Pretend to work.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Work',
          execute: async () => ({ output: 'should never run' }),
        }),
      };
      local.get(IAgentToolRegistryService).register(workTool);
      local.get(IAgentLoopService).update({ activeToolNames: ['Work'] });
      const subscription = local.get(IAgentToolExecutorService).registerHook({
        beforeExecute: () => {
          throw new Error('beforeExecute blew up');
        },
      });
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      await local.rpc.prompt({ input: [{ type: 'text', text: 'use the tool' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          error_type: 'internal',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it.each([
    ['user_cancelled', () => userCancellationReason()],
    ['aborted', () => new Error('stop')],
  ] as const)(
    'emits turn_interrupted with interrupt_reason %s on cancellation',
    async (expected, makeReason) => {
      const records: TelemetryRecord[] = [];
      const local = createTestAgent({ telemetry: recordingTelemetry(records) });
      try {
        const localLoop = local.get(IAgentLoopService);
        let stepStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          stepStarted = resolve;
        });
        localLoop.hooks.onWillBeginStep.register('test-hang', async (hookCtx, next) => {
          stepStarted();
          await new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
              once: true,
            });
          });
          await next();
        });

        const turn = submitTurn(localLoop, 'hang').turn;
        await started;
        localLoop.cancel({ turnId: turn.id }, makeReason());
        await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

        expect(records).toContainEqual({
          event: 'turn_interrupted',
          properties: expect.objectContaining({ turn_id: 0, interrupt_reason: expected, mode: 'agent' }),
        });
        expect(records).toContainEqual({
          event: 'turn_ended',
          properties: expect.objectContaining({ reason: 'cancelled' }),
        });
      } finally {
        await local.dispose();
      }
    },
  );
});

describe('interruption reminder', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;

  beforeEach(async () => {
    ctx = createTestAgent();
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function cancelOnFirstDelta(): IDisposable {
    return ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
  }

  function remindersIn(target: TestAgentContext): ContextMessage[] {
    return target.contextData().history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'interruption',
    );
  }

  function interruptionReminders(): ContextMessage[] {
    return remindersIn(ctx);
  }

  function contentPartRecordsIn(target: TestAgentContext): number {
    return target.allEvents.filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'content.part',
    ).length;
  }

  it('preserves the partial stream and appends one reminder before turn.ended', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history.slice(0, 2)).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
        providerMessageId: 'mock-1',
        toolCalls: [],
        usage: { inputOther: 0, output: 0, inputCacheCreation: 0 },
      },
    ]);
    expect(interruptionReminders()).toHaveLength(1);
    expect(interruptionReminders()[0]!.content).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user\'s next message continues the conversation.\n</system-reminder>',
      },
    ]);
    expect(ctx.contextData().history.indexOf(interruptionReminders()[0]!)).toBe(2);
    const wire = ctx.allEvents.filter((entry) => entry.type === '[wire]');
    const reminderAt = wire.findIndex((entry) => {
      if (entry.event !== 'context.append_message') return false;
      const origin = (entry.args as { message?: ContextMessage }).message?.origin;
      return origin?.kind === 'injection' && origin.variant === 'interruption';
    });
    const endedAt = wire.findIndex((entry) => entry.event === 'turn.ended');
    expect(reminderAt).toBeGreaterThanOrEqual(0);
    expect(endedAt).toBeGreaterThan(reminderAt);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({
      turnId: 0,
      target: 'active',
      reason: 'user_cancelled',
    });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });
    expect(contentPartRecordsIn(ctx)).toBe(1);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(interruptionReminders()).toHaveLength(1);
    expect(ctx.contextData().history.indexOf(interruptionReminders()[0]!)).toBe(2);
  });

  it('writes one active cancellation when cancel repeats before the turn settles', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const results: boolean[] = [];
    let cancelled = false;
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      if (cancelled) return;
      cancelled = true;
      results.push(loop.cancel(), loop.cancel());
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(results).toEqual([true, true]);
    expect(interruptionReminders()).toHaveLength(1);
    expect(
      ctx.allEvents.filter(
        (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
      ),
    ).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('preserves the partial stream but appends no reminder on programmatic abort', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel(undefined, new Error('stop'));
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      providerMessageId: 'mock-1',
      toolCalls: [],
      usage: { inputOther: 0, output: 0, inputCacheCreation: 0 },
    });
    expect(interruptionReminders()).toHaveLength(0);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({ target: 'active', reason: 'aborted' });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'cancelled', interruptReason: 'aborted' });
  });

  it('does not stack a second reminder without an intervening message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.get(IEventBus).publish(
      new TurnEnded({ agentId: 'main',
        turnId: 99,
        reason: 'cancelled',
        interruptReason: 'user_cancelled',
      }),
    );

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('appends no reminder when a queued turn is user-cancelled before starting', async () => {
    let release!: () => void;
    let armed = true;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-hang-queued-cancel', async (hookCtx, next) => {
      if (armed) {
        armed = false;
        signalEntered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'unreached' });

    const active = submitTurn(loop, 'active').turn;
    const queued = submitTurn(loop, 'queued').turn;
    expect(queued.cancel()).toBe(true);
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    expect(interruptionReminders()).toHaveLength(0);
    await entered;
    release();
    loop.cancel({ turnId: active.id });
    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('sends the reminder recorded on the cancelled turn ahead of the next user message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    ctx.llmInputs();

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "partial answer"
        user: text "<system-reminder>\\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.\\n</system-reminder>"
        user: text "Next"
    `);
  });

  it('undo removes a pending interruption with its cancelled turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([]);
    await ctx.expectResumeMatches();

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(0);
  });

  it('keeps an interruption reminder when undo only removes a later turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    const interruptedHistory = ctx.contextData().history;

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual(interruptedHistory);
    expect(interruptionReminders()).toHaveLength(1);
    await ctx.expectResumeMatches();

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([]);
  });

  it('retry continues after an assistant response without appending a user message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    const first = submitTurn(loop, 'Hello').turn;
    await expect(first.result).resolves.toMatchObject({ type: 'completed' });
    const usersBefore = ctx.contextData().history.filter((message) => message.role === 'user');

    ctx.mockNextResponse({ type: 'text', text: 'retried answer' });
    const result = await loop.retry();

    expect(result).toMatchObject({ type: 'completed' });
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.contextData().history.filter((message) => message.role === 'user')).toEqual(usersBefore);
    await ctx.expectResumeMatches();
  });

  it('drops unsigned thinking but keeps signed thinking on user cancel', async () => {
    ctx.mockNextResponse({ type: 'think', think: 'pondering' }, { type: 'text', text: 'answer' });
    const subscription = ctx.get(IEventBus).subscribe(ThinkingDelta, () => {
      loop.cancel();
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    const thinkParts = ctx
      .contextData()
      .history.flatMap((message) => message.content)
      .filter((part) => part.type === 'think');
    expect(thinkParts).toEqual([]);
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse(
      { type: 'think', think: 'seg', encrypted: 'sig' },
      { type: 'text', text: 'partial answer' },
    );
    const second = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
    const secondTurn = submitTurn(loop, 'Again').turn;
    await expect(secondTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    second.dispose();
    expect(interruptionReminders()).toHaveLength(2);

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [
        { type: 'think', think: 'seg', encrypted: 'sig', detailsIndex: 0, reasoningKey: 'reasoning_details' },
        { type: 'text', text: 'partial answer' },
      ],
      providerMessageId: 'mock-2',
      toolCalls: [],
      usage: { inputOther: 0, output: 0, inputCacheCreation: 0 },
    });
    ctx.mockNextResponse({ type: 'text', text: 'continued answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(2);
  });

  it('records no partial content when the stream only produced whitespace', async () => {
    ctx.mockNextResponse({ type: 'text', text: '  ' }, { type: 'text', text: 'answer' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(contentPartRecordsIn(ctx)).toBe(0);
    expect(ctx.contextData().history.slice(0, 1)).toEqual([
      expect.objectContaining({ role: 'user' }),
    ]);
    expect(interruptionReminders()).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'continued answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('retry after cancellation does not add another reminder or retry user message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    const firstTurn = submitTurn(loop, 'Hello').turn;
    await expect(firstTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);
    const usersBefore = ctx.contextData().history.filter((message) => message.role === 'user');

    ctx.mockNextResponse({ type: 'text', text: 'retried answer' });
    const result = await loop.retry();

    expect(result).toMatchObject({ type: 'completed' });
    expect(interruptionReminders()).toHaveLength(1);
    expect(ctx.contextData().history.filter((message) => message.role === 'user')).toEqual(usersBefore);
    await ctx.expectResumeMatches();
  });

  it('renders a new interruption reminder after an intervening completed turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first partial answer' });
    const first = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();
    first.dispose();

    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'completed prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'second partial answer' });
    const second = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();
    second.dispose();
    expect(interruptionReminders()).toHaveLength(2);

    ctx.mockNextResponse({ type: 'text', text: 'final answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'final prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(2);
  });

  it('does not duplicate recorded content when cancelled during tool execution', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    const releaseSlowTool = deferred();
    await local.restorePersisted();
    try {
      const slowToolStarted = registerAbortableWorkTool(local, releaseSlowTool.promise);
      const localLoop = local.get(IAgentLoopService);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      local.mockNextResponse(
        { type: 'text', text: 'still working' },
        { type: 'function', id: 'call-work-2', name: 'Work', arguments: '{}' },
      );
      const turn = submitTurn(localLoop, 'do work').turn;
      await slowToolStarted.promise;
      localLoop.cancel({ turnId: turn.id });
      localLoop.cancel({ turnId: turn.id });
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(contentPartRecordsIn(local)).toBe(2);
      expect(remindersIn(local)).toHaveLength(1);

      const loopEvents = local.allEvents
        .filter((entry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event')
        .map((entry) => (entry.args as { event: LoopRecordedEvent }).event);
      const toolCalls = loopEvents.filter((event) => event.type === 'tool.call');
      const toolResults = loopEvents.filter((event) => event.type === 'tool.result');
      for (const call of toolCalls) {
        expect(
          toolResults.some(
            (result) => result.toolCallId === call.toolCallId && result.parentUuid === call.uuid,
          ),
        ).toBe(true);
      }
      expect(toolResults.find((event) => event.toolCallId === 'call-work-1')?.result.durationMs).toEqual(
        expect.any(Number),
      );
      expect(toolResults.filter((event) => event.toolCallId === 'call-work-2')).toEqual([
        expect.objectContaining({
          result: {
            output:
              'The user manually interrupted "Work" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user\'s next instruction.',
            isError: true,
            durationMs: expect.any(Number),
          },
        }),
      ]);

      releaseSlowTool.resolve();
      local.newEvents();
      local.mockNextResponse({ type: 'text', text: 'follow-up answer' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
      await local.untilTurnEnd();

      const history = local.contextData().history;
      expect(remindersIn(local)).toHaveLength(1);
      const reminderIndex = history.indexOf(remindersIn(local)[0]!);
      expect(history.slice(0, reminderIndex).some((message) => message.role === 'tool')).toBe(true);
      expect(history[reminderIndex + 1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'again' }],
      });
      expect(history.at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'follow-up answer' }],
      });

      await local.expectResumeMatches();
    } finally {
      releaseSlowTool.resolve();
      await local.dispose();
    }
  });
});

describe('step timing split propagation', () => {
  it('carries current timing and ignores a late outcome from an aborted turn', async () => {
    const late = createLateTimingGenerate();
    const ctx = createTestAgent({ generate: late.generate });
    try {
      const loop = ctx.get(IAgentLoopService);
      const first = submitTurn(loop, 'old').turn;
      await late.firstStarted.promise;
      const second = submitTurn(loop, 'new').turn;
      first.cancel(new Error('stop'));
      first.cancel(new Error('stop'));
      await expect(first.result).resolves.toMatchObject({ type: 'cancelled' });
      await late.secondStarted.promise;

      late.resolveFirst();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const currentTiming = (loop as unknown as {
        active?: { current?: { timing?: unknown } };
      }).active?.current?.timing;
      expect(currentTiming).toBeUndefined();

      late.resolveSecond();
      await expect(second.result).resolves.toMatchObject({ type: 'completed' });
      const completed = ctx.allEvents.findLast(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
      );
      expect(completed?.args).toMatchObject({ llmFirstTokenLatencyMs: expect.any(Number) });
    } finally {
      late.resolveFirst();
      late.resolveSecond();
      await ctx.dispose();
    }
  });
});

describe('aborted step tool execution', () => {
  it('accounts model usage when the step is aborted during tool execution', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    await ctx.restorePersisted();
    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish the task' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 60 } });
      ctx.get(IEventBus).publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));

      const loopService = ctx.get(IAgentLoopService);
      const { turn } = submitTurn(loopService, 'work');
      await slowToolStarted.promise;
      turn.cancel(new Error('cancelled by test'));

      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(ctx.usage.status()).toMatchObject({
        total: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        currentTurn: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        tokensUsed: 61,
        budget: { tokenBudgetReached: true },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('includes the programmatic abort reason when a tool execution is interrupted', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    let interrupted: { readonly reason: string; readonly message?: string } | undefined;
    const subscription = ctx
      .get(IEventBus)
      .subscribe(TurnStepInterrupted, (event) => {
        interrupted = event;
      });

    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const loopService = ctx.get(IAgentLoopService);
      const { turn } = submitTurn(loopService, 'work');
      await slowToolStarted.promise;
      turn.cancel(new Error('Tool execution timed out'));

      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(interrupted).toMatchObject({
        reason: 'aborted',
        message: 'Tool execution timed out',
      });
    } finally {
      subscription.dispose();
      await ctx.dispose();
    }
  });

  it('settles a message-less notification without creating an LLM request', async () => {
    const requester: LoopRequester = {
      coreRequester: () => createMockProviderRequester(async () => {
        throw new Error('request must not run');
      }),
      prepareOperation: async () => createMockProviderRequester(async () => {
        throw new Error('request must not run');
      }),
    };
    const ctx = createTestAgent();
    await replaceLoopRequester(ctx, requester);
    try {
      const loopService = ctx.get(IAgentLoopService);
      const handle = loopService.notify();
      await loopService.settled();
      expect(handle.dropped).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}

async function replaceLoopRequester(ctx: TestAgentContext, requester: LoopRequester): Promise<void> {
  const loop = ctx.get(IAgentLoopService) as { requester: LoopRequester } & IAgentLoopService;
  loop.requester = requester;
  await loop.initializeHistory([]);
}

function parkedLifecycleStub(): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: Event.None as Event<AgentContext>,
    onDidCreateScope: Event.None as Event<AgentScopeCreatedEvent>,
    onWillClose: Event.None as Event<AgentContext>,
    onDidClose: Event.None as Event<AgentContext>,
    create: () => Promise.reject(new Error('parked lifecycle stub')),
    fork: () => Promise.reject(new Error('parked lifecycle stub')),
    get: () => undefined,
    list: () => [],
    broadcastPermissionMode: () => {},
    remove: () => Promise.resolve(),
    handleOf: () => undefined,
    adopt: (handle) => agentContextOf(handle),
  };
}

function createLateTimingGenerate() {
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstGate = deferred();
  const secondGate = deferred();
  let calls = 0;
  const generate = createMockProvider(async () => {
    calls += 1;
    const current = calls;
    if (current === 1) {
      firstStarted.resolve();
      await firstGate.promise;
    } else if (current === 2) {
      secondStarted.resolve();
      await secondGate.promise;
    } else {
      throw new Error('Unexpected model request');
    }
    return {
      id: `mock-${String(current)}`,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: current === 1 ? 'old' : 'new' }],
        toolCalls: [],
      },
      usage: emptyUsage(),
      finishReason: 'completed',
      rawFinishReason: 'stop',
    };
  });
  return {
    generate,
    firstStarted,
    secondStarted,
    resolveFirst: firstGate.resolve,
    resolveSecond: secondGate.resolve,
  };
}

function createAbortedStepGenerate(): GenerateFn {
  const usages = [
    { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 7, output: 11, inputCacheRead: 0, inputCacheCreation: 0 },
  ];
  let requestIndex = 0;

  return createMockProvider(async () => {
    const usage = usages[requestIndex];
    if (usage === undefined) throw new Error('Unexpected model request');
    requestIndex += 1;
    return {
      id: `response-${String(requestIndex)}`,
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: `call-work-${String(requestIndex)}`,
            name: 'Work',
            arguments: '{}',
          },
        ],
      },
      usage,
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  });
}

function registerAbortableWorkTool(
  ctx: TestAgentContext,
  ignoreAbortGate?: Promise<void>,
): ReturnType<typeof deferred> {
  const slowToolStarted = deferred();
  let executions = 0;
  const tool: ExecutableTool = {
    name: 'Work',
    description: 'Run one fast operation and one cancellable operation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: () => ({
      approvalRule: 'Work',
      accesses: [],
      execute: async ({ signal }) => {
        executions += 1;
        if (executions === 1) return { output: 'first step complete' };
        slowToolStarted.resolve();
        if (ignoreAbortGate !== undefined) {
          await ignoreAbortGate;
          return { output: 'second step late result' };
        }
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        return { output: 'second step cancelled' };
      },
    }),
  };
  ctx.get(IAgentLoopService).update({ activeToolNames: ['Work'] });
  ctx.get(IAgentToolRegistryService).register(tool);
  return slowToolStarted;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
