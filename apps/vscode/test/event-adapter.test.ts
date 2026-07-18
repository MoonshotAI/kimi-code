/**
 * Scenario: public Node SDK events are projected into the released VS Code Webview protocol.
 * Responsibilities: verify legacy shapes, routing state, and terminal metadata one event at a time.
 * Wiring: the pure adapter and real protocol types are used directly; there are no stubs.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/event-adapter.test.ts
 */

import { describe, expect, it } from 'vitest';

import { isPreflightError } from '../shared/errors';
import {
  adaptSdkEvent,
  createEventAdapterState,
} from '../src/runtime/event-adapter';

describe('event adapter (projects SDK events into the legacy Webview contract)', () => {
  it('emits the pending input when a main-agent turn starts', () => {
    const result = adaptSdkEvent(
      createEventAdapterState(),
      {
        type: 'turn.started',
        sessionId: 'session-1',
        agentId: 'main',
        turnId: 7,
        origin: { kind: 'user' },
      },
      { pendingInput: 'Fix the failing test' },
    );

    expect(result.event).toEqual({
      type: 'TurnBegin',
      payload: { user_input: 'Fix the failing test' },
      _sessionId: 'session-1',
    });
  });

  it('emits text content when the assistant streams a delta', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'assistant.delta',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      delta: 'Done',
    });

    expect(result.event).toEqual({
      type: 'ContentPart',
      payload: { type: 'text', text: 'Done' },
      _sessionId: 'session-1',
    });
  });

  it('emits thinking content when the model streams a thinking delta', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'thinking.delta',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      delta: 'Checking the types',
    });

    expect(result.event).toEqual({
      type: 'ContentPart',
      payload: { type: 'think', think: 'Checking the types' },
      _sessionId: 'session-1',
    });
  });

  it('emits a numbered legacy step when an SDK step starts', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'turn.step.started',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      step: 2,
      stepId: 'step-2',
    });

    expect(result.event).toEqual({
      type: 'StepBegin',
      payload: { n: 2 },
      _sessionId: 'session-1',
    });
  });

  it.each([
    ['Bash', 'Shell'],
    ['Read', 'ReadFile'],
    ['Write', 'WriteFile'],
    ['Edit', 'StrReplaceFile'],
    ['TodoList', 'SetTodoList'],
    ['Glob', 'Glob'],
  ] as const)('maps the %s tool name to %s when a tool starts', (sdkName, legacyName) => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'tool.call.started',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-1',
      name: sdkName,
      args: { path: 'src/index.ts' },
    });

    expect(result.event).toEqual({
      type: 'ToolCall',
      payload: {
        type: 'function',
        id: 'tool-1',
        function: {
          name: legacyName,
          arguments: '{"path":"src/index.ts"}',
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('preserves each tool-call ID when argument deltas are interleaved', () => {
    const state = createEventAdapterState();
    const first = adaptSdkEvent(state, {
      type: 'tool.call.delta',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-a',
      name: 'Read',
      argumentsPart: '{"path":"a',
    });
    const second = adaptSdkEvent(first.state, {
      type: 'tool.call.delta',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-b',
      name: 'Read',
      argumentsPart: '{"path":"b',
    });

    expect([first.event, second.event]).toEqual([
      {
        type: 'ToolCallPart',
        payload: { tool_call_id: 'tool-a', arguments_part: '{"path":"a' },
        _sessionId: 'session-1',
      },
      {
        type: 'ToolCallPart',
        payload: { tool_call_id: 'tool-b', arguments_part: '{"path":"b' },
        _sessionId: 'session-1',
      },
    ]);
  });

  it('emits a legacy result when an SDK tool call finishes', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'tool.result',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-1',
      output: { exitCode: 0 },
      isError: false,
    });

    expect(result.event).toEqual({
      type: 'ToolResult',
      payload: {
        tool_call_id: 'tool-1',
        return_value: {
          is_error: false,
          output: '{\n  "exitCode": 0\n}',
          message: '',
          display: [],
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('carries a file diff display from tool start into its matching result', () => {
    const started = adaptSdkEvent(createEventAdapterState(), {
      type: 'tool.call.started',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-1',
      name: 'Edit',
      args: { path: 'src/index.ts' },
      display: {
        kind: 'diff',
        path: 'src/index.ts',
        before: 'old',
        after: 'new',
      },
    });
    const finished = adaptSdkEvent(started.state, {
      type: 'tool.result',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'tool-1',
      output: 'updated',
    });

    expect(finished.event).toMatchObject({
      type: 'ToolResult',
      payload: {
        return_value: {
          display: [{
            type: 'diff',
            path: 'src/index.ts',
            old_text: 'old',
            new_text: 'new',
          }],
        },
      },
    });
  });

  it('carries a todo display only to the result with the same tool-call ID', () => {
    const started = adaptSdkEvent(createEventAdapterState(), {
      type: 'tool.call.started',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'todo-1',
      name: 'TodoList',
      args: {},
      display: {
        kind: 'todo_list',
        items: [{ title: 'Ship it', status: 'done' }],
      },
    });
    const unrelated = adaptSdkEvent(started.state, {
      type: 'tool.result',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'other',
      output: 'other result',
    });

    expect(unrelated.event).toMatchObject({
      payload: { return_value: { display: [] } },
    });
    expect(unrelated.state.toolDisplays['todo-1']).toEqual([
      { type: 'todo', items: [{ title: 'Ship it', status: 'done' }] },
    ]);
    const matching = adaptSdkEvent(unrelated.state, {
      type: 'tool.result',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'todo-1',
      output: 'updated',
    });
    expect(matching.event).toMatchObject({
      payload: {
        return_value: {
          display: [{ type: 'todo', items: [{ title: 'Ship it', status: 'done' }] }],
        },
      },
    });
  });

  it('emits snake-case status fields when agent status changes', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'agent.status.updated',
      sessionId: 'session-1',
      agentId: 'main',
      contextUsage: 0.25,
      planMode: true,
      usage: {
        currentTurn: {
          inputOther: 10,
          output: 4,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
    });

    expect(result.event).toEqual({
      type: 'StatusUpdate',
      payload: {
        context_usage: 0.25,
        plan_mode: true,
        token_usage: {
          input_other: 10,
          output: 4,
          input_cache_read: 3,
          input_cache_creation: 2,
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('emits only new token usage when SDK status carries cumulative turn usage', () => {
    const first = adaptSdkEvent(createEventAdapterState(), {
      type: 'agent.status.updated',
      sessionId: 'session-1',
      agentId: 'main',
      usage: {
        currentTurn: {
          inputOther: 10,
          output: 4,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
    });
    const second = adaptSdkEvent(first.state, {
      type: 'agent.status.updated',
      sessionId: 'session-1',
      agentId: 'main',
      usage: {
        currentTurn: {
          inputOther: 14,
          output: 7,
          inputCacheRead: 8,
          inputCacheCreation: 2,
        },
      },
    });

    expect(second.event).toEqual({
      type: 'StatusUpdate',
      payload: {
        token_usage: {
          input_other: 4,
          output: 3,
          input_cache_read: 5,
          input_cache_creation: 0,
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('routes a child-agent event through its parent tool after spawn', () => {
    const spawned = adaptSdkEvent(createEventAdapterState(), {
      type: 'subagent.spawned',
      sessionId: 'session-1',
      agentId: 'main',
      subagentId: 'child-1',
      subagentName: 'coder',
      parentToolCallId: 'agent-call-1',
      parentAgentId: 'main',
      runInBackground: false,
    });
    const childEvent = adaptSdkEvent(spawned.state, {
      type: 'assistant.delta',
      sessionId: 'session-1',
      agentId: 'child-1',
      turnId: 1,
      delta: 'Child result',
    });

    expect(childEvent.event).toEqual({
      type: 'SubagentEvent',
      payload: {
        parent_tool_call_id: 'agent-call-1',
        event: {
          type: 'ContentPart',
          payload: { type: 'text', text: 'Child result' },
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('scopes a child tool-call ID when the child starts a tool', () => {
    const spawned = adaptSdkEvent(createEventAdapterState(), {
      type: 'subagent.spawned',
      sessionId: 'session-1',
      agentId: 'main',
      subagentId: 'child-1',
      subagentName: 'coder',
      parentToolCallId: 'agent-call-1',
      parentAgentId: 'main',
      runInBackground: false,
    });
    const childEvent = adaptSdkEvent(spawned.state, {
      type: 'tool.call.started',
      sessionId: 'session-1',
      agentId: 'child-1',
      turnId: 1,
      toolCallId: 'tool-1',
      name: 'Read',
      args: { path: 'README.md' },
    });

    expect(childEvent.event).toEqual({
      type: 'SubagentEvent',
      payload: {
        parent_tool_call_id: 'agent-call-1',
        event: {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: 'child-1:tool-1',
            function: {
              name: 'ReadFile',
              arguments: '{"path":"README.md"}',
            },
          },
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('emits compaction begin when SDK compaction starts', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'compaction.started',
      sessionId: 'session-1',
      agentId: 'main',
      trigger: 'manual',
    });

    expect(result.event).toEqual({
      type: 'CompactionBegin',
      payload: {},
      _sessionId: 'session-1',
    });
  });

  it.each([
    {
      type: 'compaction.completed' as const,
      result: { summary: 'Summary', compactedCount: 3, tokensBefore: 100, tokensAfter: 30 },
    },
    { type: 'compaction.cancelled' as const },
    { type: 'compaction.blocked' as const, turnId: 7 },
  ])('emits compaction end when SDK reports $type', (event) => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      ...event,
      sessionId: 'session-1',
      agentId: 'main',
    });

    expect(result.event).toEqual({
      type: 'CompactionEnd',
      payload: {},
      _sessionId: 'session-1',
    });
  });

  it('returns terminal metadata when the main turn completes', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'turn.ended',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'completed',
      durationMs: 50,
    });

    expect(result.event).toBeUndefined();
    expect(result.terminal).toEqual({
      key: 'session-1:main:7',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'completed',
      error: undefined,
    });
  });

  it('preserves the SDK error when a main turn fails', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'turn.ended',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'failed',
      error: {
        code: 'internal',
        message: 'Provider failed',
        retryable: false,
      },
    });

    expect(result.terminal).toEqual({
      key: 'session-1:main:7',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'failed',
      error: {
        code: 'internal',
        message: 'Provider failed',
        retryable: false,
      },
    });
  });

  it('emits a bridge error with the caller-selected phase when the SDK reports an error', () => {
    const result = adaptSdkEvent(
      createEventAdapterState(),
      {
        type: 'error',
        sessionId: 'session-1',
        agentId: 'main',
        code: 'internal',
        message: 'Configuration failed',
        details: { path: 'config.toml' },
        retryable: false,
      },
      { errorPhase: 'preflight' },
    );

    expect(result.event).toEqual({
      type: 'error',
      code: 'internal',
      message: 'Configuration failed',
      detail: '{\n  "path": "config.toml"\n}',
      phase: 'preflight',
      _sessionId: 'session-1',
    });
  });

  it('classifies a missing Windows Git Bash runtime as a preflight error', () => {
    expect(isPreflightError('shell.git_bash_not_found')).toBe(true);
  });
});
