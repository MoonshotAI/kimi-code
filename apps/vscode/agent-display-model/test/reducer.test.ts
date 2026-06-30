import { describe, expect, it } from 'vitest';

import { createInitialDisplayState, finalizeDisplayStateForHistory, reduceDisplayEvent, type DisplayState } from '../src';

function reduceAll(events: Parameters<typeof reduceDisplayEvent>[1][], state: DisplayState = createInitialDisplayState()) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const reduction = reduceDisplayEvent(current, event);
    current = reduction.state;
    effects.push(...reduction.effects);
  }
  return { state: current, effects };
}

describe('reduceDisplayEvent', () => {
  it('builds user/assistant messages and streams text', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: ' hello ' },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'thinking', text: 'thinking' },
      { type: 'content.append', kind: 'text', text: 'answer' },
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.isStreaming).toBe(true);
    const assistant = state.messages[1];
    expect(assistant?.steps?.[0]?.parts).toEqual([
      { type: 'thinking', text: 'thinking', finished: true },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('keeps user media parts and appends assistant media parts', () => {
    const { state } = reduceAll([
      {
        type: 'turn.begin',
        userText: 'look\n[image img-1]',
        parts: [
          { type: 'text', text: 'look' },
          { type: 'media', kind: 'image', url: 'data:image/png;base64,abc', id: 'img-1' },
        ],
      },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'media', media: { type: 'media', kind: 'video', url: 'data:video/mp4;base64,abc' } },
    ]);

    expect(state.messages[0]?.parts).toEqual([
      { type: 'text', text: 'look' },
      { type: 'media', kind: 'image', url: 'data:image/png;base64,abc', id: 'img-1' },
    ]);
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: 'media', kind: 'video', url: 'data:video/mp4;base64,abc' });
  });

  it('tracks tool calls and emits file tracking effects for diff results', () => {
    const { state, effects } = reduceAll([
      { type: 'turn.begin', userText: 'edit file' },
      { type: 'tool.call', id: 'tool-1', name: 'Edit', argumentsText: '{"path":"a.ts"}' },
      {
        type: 'tool.result',
        id: 'tool-1',
        output: 'ok',
        displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
      },
    ]);

    const tool = state.messages[1]?.steps?.[0]?.parts[0];
    expect(tool).toMatchObject({ type: 'tool-call', id: 'tool-1', status: 'success', resultText: 'ok' });
    expect(effects).toContainEqual({ type: 'TrackFiles', paths: ['a.ts'] });
  });

  it('updates status and token usage', () => {
    const { state, effects } = reduceAll([
      { type: 'turn.begin', userText: 'status' },
      {
        type: 'status.update',
        status: {
          contextUsage: 0.5,
          contextTokens: 50,
          maxContextTokens: 100,
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        },
      },
    ]);

    expect(state.status?.contextUsage).toBe(0.5);
    expect(state.activeTokenUsage.output).toBe(2);
    expect(effects).toContainEqual({ type: 'UpdateStatus', status: state.status });
  });

  it('finalizes streaming state on turn completion', () => {
    const { state, effects } = reduceAll([
      { type: 'turn.begin', userText: 'complete' },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'thinking', text: 'draft' },
      {
        type: 'status.update',
        status: {
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        },
      },
      { type: 'turn.complete' },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.activeTokenUsage.output).toBe(0);
    expect(state.tokenUsage.output).toBe(2);
    expect(state.messages[1]?.status).toBe('completed');
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({ type: 'thinking', text: 'draft', finished: true });
    expect(effects).toContainEqual({ type: 'ClearApprovals' });
  });

  it('finalizes history display state without mutating the source state', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'history' },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'text', text: 'draft' },
      {
        type: 'status.update',
        status: {
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        },
      },
    ]);

    const finalized = finalizeDisplayStateForHistory(state);

    expect(state.isStreaming).toBe(true);
    expect(state.activeTokenUsage.output).toBe(2);
    expect(state.messages[1]?.steps?.[0]?.parts).toEqual([
      { type: 'text', text: 'draft' },
      { type: 'status', status: state.status },
    ]);
    expect(finalized.isStreaming).toBe(false);
    expect(finalized.isCompacting).toBe(false);
    expect(finalized.activeTokenUsage).toEqual({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });
    expect(finalized.tokenUsage).toEqual({ inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 });
    expect(finalized.messages[1]?.status).toBe('completed');
    expect(finalized.messages[1]?.steps?.[0]?.parts).toEqual([
      { type: 'text', text: 'draft', finished: true },
      { type: 'status', status: finalized.status },
    ]);
  });

  it('stores compaction metadata on display parts', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'compact' },
      { type: 'compaction.begin', trigger: 'manual', instruction: 'summarize aggressively', message: 'starting compaction' },
      {
        type: 'compaction.end',
        status: 'completed',
        trigger: 'manual',
        summary: 'compacted 42 items',
        compactedCount: 42,
        tokensBefore: 12000,
        tokensAfter: 3000,
        message: 'compaction done',
      },
    ]);

    expect(state.isCompacting).toBe(false);
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: 'compaction',
      status: 'running',
      trigger: 'manual',
      instruction: 'summarize aggressively',
      message: 'starting compaction',
    });
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: 'compaction',
      status: 'completed',
      trigger: 'manual',
      summary: 'compacted 42 items',
      compactedCount: 42,
      tokensBefore: 12000,
      tokensAfter: 3000,
      message: 'compaction done',
    });
  });

  it('stores runtime errors as display error parts and finalizes the turn', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'error' },
      {
        type: 'turn.error',
        error: {
          code: 'RUNTIME_ERROR',
          message: 'Runtime failed',
          phase: 'runtime',
          details: { category: 'protocol', context: { requestId: 'req-1' } },
        },
      },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages[1]?.status).toBe('error');
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: 'error',
      error: {
        code: 'RUNTIME_ERROR',
        message: 'Runtime failed',
        phase: 'runtime',
        details: { category: 'protocol', context: { requestId: 'req-1' } },
      },
    });
  });

  it('rolls back empty preflight turns without leaving display error parts', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'first' },
      { type: 'content.append', kind: 'text', text: 'ok' },
      { type: 'turn.complete' },
      { type: 'turn.begin', userText: 'second' },
      { type: 'turn.error', error: { code: 'HANDSHAKE_TIMEOUT', message: 'Connection timed out.', phase: 'preflight' } },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.parts).toEqual([{ type: 'text', text: 'first' }]);
    expect(state.messages[1]?.status).toBe('completed');
  });

  it('stores interruptions as display interrupt parts and finalizes the turn', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'interrupt' },
      { type: 'turn.interrupted', reason: 'TURN_INTERRUPTED', message: 'Stopped by user.' },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages[1]?.status).toBe('interrupted');
    expect(state.messages[1]?.steps?.[0]?.parts).toContainEqual({
      type: 'interrupt',
      reason: 'TURN_INTERRUPTED',
      message: 'Stopped by user.',
    });
  });

  it('nests subagent steps under the parent tool call', () => {
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'delegate' },
      { type: 'tool.call', id: 'task-1', name: 'Task', argumentsText: '{"prompt":"inspect"}' },
      { type: 'subagent.event', parentToolCallId: 'task-1', event: { type: 'step.begin', n: 1 } },
      {
        type: 'subagent.event',
        parentToolCallId: 'task-1',
        event: { type: 'content.append', kind: 'text', text: 'child output' },
      },
    ]);

    const parent = state.messages[1]?.steps?.[0]?.parts[0];
    expect(parent?.type).toBe('tool-call');
    expect(parent && parent.type === 'tool-call' ? parent.children?.[0]?.parts : undefined).toEqual([
      { type: 'text', text: 'child output' },
    ]);
  });

  it('opens approval requests with display blocks and dynamic options', () => {
    const { state, effects } = reduceAll([
      { type: 'turn.begin', userText: 'approve' },
      {
        type: 'approval.request',
        request: {
          type: 'approval',
          requestId: 0,
          toolCallId: 'tool-1',
          sender: 'agent',
          action: 'Edit',
          description: 'Edit a file',
          displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
          options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
        },
      },
    ]);

    expect(state.pendingApprovals).toEqual([
      {
        type: 'approval',
        requestId: 0,
        toolCallId: 'tool-1',
        sender: 'agent',
        action: 'Edit',
        description: 'Edit a file',
        displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
        options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
      },
    ]);
    expect(effects).toContainEqual({ type: 'OpenApproval', request: state.pendingApprovals[0] });

    const resolved = reduceDisplayEvent(state, { type: 'approval.resolved', requestId: 0 });
    expect(resolved.state.pendingApprovals).toEqual([]);
  });

  it('clones nested approval display blocks', () => {
    const displayBlocks = [
      { type: 'todo' as const, items: [{ title: 'Review diff', status: 'done' as const }] },
      { type: 'command' as const, language: 'bash', command: 'pnpm test', description: 'Run tests' },
    ];
    const { state } = reduceAll([
      {
        type: 'approval.request',
        request: {
          type: 'approval',
          requestId: 0,
          toolCallId: 'tool-1',
          sender: 'agent',
          action: 'Shell',
          description: 'Run tests',
          displayBlocks,
        },
      },
    ]);

    (displayBlocks[0] as { items: Array<{ title: string }> }).items[0]!.title = 'Changed locally';

    expect(state.pendingApprovals[0]?.displayBlocks).toEqual([
      { type: 'todo', items: [{ title: 'Review diff', status: 'done' }] },
      { type: 'command', language: 'bash', command: 'pnpm test', description: 'Run tests' },
    ]);
  });

  it('tracks pending approvals for subagent events', () => {
    const request = {
      type: 'approval' as const,
      requestId: 'approval-1',
      toolCallId: 'tool-child',
      sender: 'agent',
      action: 'Shell',
      description: 'Run command',
    };
    const { state } = reduceAll([
      { type: 'turn.begin', userText: 'delegate' },
      { type: 'tool.call', id: 'task-1', name: 'Task', argumentsText: '{"prompt":"inspect"}' },
      { type: 'subagent.event', parentToolCallId: 'task-1', event: { type: 'approval.request', request } },
    ]);

    expect(state.pendingApprovals).toEqual([request]);

    const resolved = reduceDisplayEvent(state, {
      type: 'subagent.event',
      parentToolCallId: 'task-1',
      event: { type: 'approval.resolved', requestId: 'approval-1' },
    });

    expect(resolved.state.pendingApprovals).toEqual([]);
  });

  it('stores available commands with display metadata', () => {
    const { state, effects } = reduceAll([
      {
        type: 'available_commands.update',
        commands: [
          { name: 'review', description: 'Review changes', group: 'code' },
          { name: 'test', description: 'Run tests' },
        ],
      },
    ]);

    expect(state.availableCommands).toEqual([
      { name: 'review', description: 'Review changes', group: 'code' },
      { name: 'test', description: 'Run tests' },
    ]);
    expect(effects).toContainEqual({ type: 'UpdateAvailableCommands', commands: state.availableCommands });
  });

  it('clears approvals, tracked files, and available commands on reset', () => {
    const { state, effects } = reduceAll([
      { type: 'available_commands.update', commands: [{ name: 'review', description: 'Review changes' }] },
      { type: 'conversation.reset' },
    ]);

    expect(state.availableCommands).toEqual([]);
    expect(effects).toContainEqual({ type: 'ClearApprovals' });
    expect(effects).toContainEqual({ type: 'ClearTrackedFiles' });
  });
});
