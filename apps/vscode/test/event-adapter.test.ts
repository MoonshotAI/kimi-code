/**
 * Scenario: Rust-engine events (passed through by the SDK) are projected into
 * the released VS Code Webview protocol.
 * Responsibilities: verify legacy shapes, step numbering, and terminal metadata
 * one event at a time.
 * Wiring: the pure adapter and real protocol types are used directly; there are
 * no stubs.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts apps/vscode/test/event-adapter.test.ts
 */

import { describe, expect, it } from 'vitest';

import { isPreflightError } from '../shared/errors';
import {
  adaptSdkEvent,
  createEventAdapterState,
} from '../src/runtime/event-adapter';

describe('event adapter (projects engine events into the legacy Webview contract)', () => {
  it('emits the pending input when a main turn starts', () => {
    const result = adaptSdkEvent(
      createEventAdapterState(),
      {
        type: 'session.turn.started',
        sessionId: 'session-1',
        agentId: 'main',
        turn_id: 7,
      },
      { pendingInput: 'Fix the failing test' },
    );

    expect(result.event).toEqual({
      type: 'TurnBegin',
      payload: { user_input: 'Fix the failing test' },
      _sessionId: 'session-1',
    });
  });

  it('resets the step counter when a turn starts', () => {
    const first = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.step.begin',
      sessionId: 'session-1',
      agentId: 'main',
      model: 'kimi-k2',
    });
    const second = adaptSdkEvent(first.state, {
      type: 'llm.step.begin',
      sessionId: 'session-1',
      agentId: 'main',
      model: 'kimi-k2',
    });
    const started = adaptSdkEvent(second.state, {
      type: 'session.turn.started',
      sessionId: 'session-1',
      agentId: 'main',
      turn_id: 8,
    });
    const next = adaptSdkEvent(started.state, {
      type: 'llm.step.begin',
      sessionId: 'session-1',
      agentId: 'main',
      model: 'kimi-k2',
    });

    expect(next.event).toEqual({
      type: 'StepBegin',
      payload: { n: 1 },
      _sessionId: 'session-1',
    });
  });

  it('emits text content when the model streams a text part', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.delta',
      sessionId: 'session-1',
      agentId: 'main',
      part: { type: 'text', text: 'Done' },
    });

    expect(result.event).toEqual({
      type: 'ContentPart',
      payload: { type: 'text', text: 'Done' },
      _sessionId: 'session-1',
    });
  });

  it('emits thinking content when the model streams a think part', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.delta',
      sessionId: 'session-1',
      agentId: 'main',
      part: { type: 'think', think: 'Checking the types' },
    });

    expect(result.event).toEqual({
      type: 'ContentPart',
      payload: { type: 'think', think: 'Checking the types' },
      _sessionId: 'session-1',
    });
  });

  it('drops empty streamed parts', () => {
    const text = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.delta',
      sessionId: 'session-1',
      agentId: 'main',
      part: { type: 'text', text: '' },
    });
    const think = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.delta',
      sessionId: 'session-1',
      agentId: 'main',
      part: { type: 'think', think: '' },
    });

    expect(text.event).toBeUndefined();
    expect(think.event).toBeUndefined();
  });

  it('numbers steps from the engine step stream', () => {
    const first = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.step.begin',
      sessionId: 'session-1',
      agentId: 'main',
      model: 'kimi-k2',
    });
    const second = adaptSdkEvent(first.state, {
      type: 'llm.step.begin',
      sessionId: 'session-1',
      agentId: 'main',
      model: 'kimi-k2',
    });

    expect([first.event, second.event]).toEqual([
      {
        type: 'StepBegin',
        payload: { n: 1 },
        _sessionId: 'session-1',
      },
      {
        type: 'StepBegin',
        payload: { n: 2 },
        _sessionId: 'session-1',
      },
    ]);
  });

  it.each([
    ['Bash', 'Shell'],
    ['Read', 'ReadFile'],
    ['Write', 'WriteFile'],
    ['Edit', 'StrReplaceFile'],
    ['TodoList', 'SetTodoList'],
    ['Glob', 'Glob'],
  ] as const)('maps the %s tool name to %s when a tool starts', (engineName, legacyName) => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.tool.started',
      sessionId: 'session-1',
      agentId: 'main',
      tool_call_id: 'tool-1',
      tool_name: engineName,
      arguments: { path: 'src/index.ts' },
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

  it('drops tool-call argument previews (full args arrive with the tool start)', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.delta',
      sessionId: 'session-1',
      agentId: 'main',
      part: { type: 'tool_call', id: 'tool-1', name: 'Read', args: '{"path":"a' },
    });

    expect(result.event).toBeUndefined();
  });

  it('emits a legacy result when an engine tool settles', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.tool.settled',
      sessionId: 'session-1',
      agentId: 'main',
      tool_call_id: 'tool-1',
      tool_name: 'Bash',
      content: '{"exitCode": 0}',
      is_error: false,
    });

    expect(result.event).toEqual({
      type: 'ToolResult',
      payload: {
        tool_call_id: 'tool-1',
        return_value: {
          is_error: false,
          output: '{"exitCode": 0}',
          message: '',
          display: [],
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('marks an erroring tool result as such', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.tool.settled',
      sessionId: 'session-1',
      agentId: 'main',
      tool_call_id: 'tool-1',
      tool_name: 'Read',
      content: 'File not found',
      is_error: true,
    });

    expect(result.event).toMatchObject({
      type: 'ToolResult',
      payload: {
        return_value: { is_error: true, output: 'File not found' },
      },
    });
  });

  it('emits snake-case token usage when an LLM step finishes', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'llm.step.end',
      sessionId: 'session-1',
      agentId: 'main',
      content: 'Done',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
      },
    });

    expect(result.event).toEqual({
      type: 'StatusUpdate',
      payload: {
        token_usage: {
          input_other: 10,
          output: 4,
          input_cache_read: 0,
          input_cache_creation: 0,
        },
      },
      _sessionId: 'session-1',
    });
  });

  it('drops turn-cumulative usage updates (steps already reported increments)', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.usage.updated',
      sessionId: 'session-1',
      agentId: 'main',
      turn_id: 7,
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
    });

    expect(result.event).toBeUndefined();
  });

  it('emits hook content as text', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.hook.result',
      sessionId: 'session-1',
      agentId: 'main',
      hook_event: 'PreToolUse',
      content: 'Hook approved',
      blocked: false,
    });

    expect(result.event).toEqual({
      type: 'ContentPart',
      payload: { type: 'text', text: 'Hook approved' },
      _sessionId: 'session-1',
    });
  });

  it('emits compaction begin when engine compaction starts', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.compaction.started',
      sessionId: 'session-1',
      agentId: 'main',
      source: 'manual',
      tokens_before: 100,
    });

    expect(result.event).toEqual({
      type: 'CompactionBegin',
      payload: {},
      _sessionId: 'session-1',
    });
  });

  it('returns terminal metadata when the main turn completes', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.turn.ended',
      sessionId: 'session-1',
      agentId: 'main',
      turn_id: 7,
      stop_reason: 'EndTurn',
      steps: 3,
    });

    expect(result.event).toBeUndefined();
    expect(result.terminal).toEqual({
      key: 'session-1:main:7',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'completed',
    });
  });

  it('maps an aborted engine turn to a cancelled terminal', () => {
    const result = adaptSdkEvent(createEventAdapterState(), {
      type: 'session.turn.ended',
      sessionId: 'session-1',
      agentId: 'main',
      turn_id: 7,
      stop_reason: 'Aborted',
      steps: 1,
    });

    expect(result.terminal).toEqual({
      key: 'session-1:main:7',
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      reason: 'cancelled',
    });
  });

  it.each(['Filtered', 'MaxTokens', 'BudgetLimited', 'Paused'] as const)(
    'maps the %s stop reason to a failed terminal',
    (stopReason) => {
      const result = adaptSdkEvent(createEventAdapterState(), {
        type: 'session.turn.ended',
        sessionId: 'session-1',
        agentId: 'main',
        turn_id: 7,
        stop_reason: stopReason,
        steps: 2,
      });

      expect(result.terminal?.reason).toBe('failed');
    },
  );

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
