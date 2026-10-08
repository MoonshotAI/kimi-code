import { describe, expect, it } from 'vitest';

import { foldWireRecords } from '#/agent/replayBuilder/fold';
import type { AgentReplayRecord } from '#/agent/replayBuilder/types';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

const METADATA: WireRecord = { type: 'metadata', protocol_version: '1.5', created_at: 0 };

function fold(records: readonly WireRecord[]) {
  return foldWireRecords([METADATA, ...records]);
}

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function appendMessage(message: ContextMessage, time = 1): WireRecord {
  return { type: 'context.append_message', message, time };
}

function loopEvent(event: Record<string, unknown>, time = 1): WireRecord {
  return { type: 'context.append_loop_event', event, time };
}

function messageRecords(replay: readonly AgentReplayRecord[]) {
  return replay.filter((record) => record.type === 'message');
}

describe('foldWireRecords', () => {
  it('returns an empty fold for an empty journal', () => {
    expect(foldWireRecords([])).toEqual({ replay: [], toolStore: {} });
    expect(foldWireRecords([METADATA])).toEqual({ replay: [], toolStore: {} });
  });

  it('tolerates a journal without a metadata header', () => {
    const folded = foldWireRecords([appendMessage(userMessage('hi'), 7)]);
    expect(folded.replay).toHaveLength(1);
    expect(folded.replay[0]).toMatchObject({ type: 'message', time: 7 });
  });

  it('assembles assistant messages from loop events with display round-trip', () => {
    const display = { kind: 'command', command: 'ls' } as const;
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 10),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'working' } }, 11),
      loopEvent(
        {
          type: 'tool.call',
          stepUuid: 's1',
          toolCallId: 'tc1',
          name: 'Shell',
          args: { command: 'ls' },
          display,
        },
        12,
      ),
      loopEvent(
        { type: 'tool.result', toolCallId: 'tc1', result: { output: 'file.txt', isError: false } },
        13,
      ),
      loopEvent({ type: 'step.end', uuid: 's1' }, 14),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const [assistant, tool] = messages;
    expect(assistant).toMatchObject({ type: 'message', time: 10 });
    if (assistant?.type !== 'message') throw new Error('expected message record');
    expect(assistant.message.role).toBe('assistant');
    expect(assistant.message.content).toEqual([{ type: 'text', text: 'working' }]);
    expect(assistant.message.toolCalls).toEqual([
      { type: 'function', id: 'tc1', name: 'Shell', arguments: '{"command":"ls"}', extras: undefined },
    ]);
    expect(assistant.message.toolCallDisplays).toEqual({ tc1: display });
    if (tool?.type !== 'message') throw new Error('expected message record');
    expect(tool.message).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
    });
    expect(tool.time).toBe(13);
  });

  it('defers messages behind an open tool exchange and flushes them in order', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
      appendMessage(userMessage('deferred', { kind: 'injection', variant: 'x' }), 3),
      loopEvent({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'done' } }, 4),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages.map((record) => (record.type === 'message' ? record.message.role : ''))).toEqual([
      'assistant',
      'tool',
      'user',
    ]);
    const deferred = messages[2];
    if (deferred?.type !== 'message') throw new Error('expected message record');
    expect(deferred.time).toBe(4);
  });

  it('synthesizes interrupted tool results at a mid-history step boundary', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
      loopEvent({ type: 'step.begin', uuid: 's2' }, 5),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(3);
    const synthesized = messages[1];
    if (synthesized?.type !== 'message') throw new Error('expected message record');
    expect(synthesized.message).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      isError: true,
    });
    expect(synthesized.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('interrupted'),
    });
    expect(synthesized.time).toBe(5);
  });

  it('closes a trailing open exchange at the end of the journal', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const synthesized = messages[1];
    if (synthesized?.type !== 'message') throw new Error('expected message record');
    expect(synthesized.message).toMatchObject({ role: 'tool', toolCallId: 'tc1', isError: true });
  });

  it('drops a tool result whose call is not pending', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent({ type: 'tool.result', toolCallId: 'ghost', result: { output: 'late' } }, 2),
    ]);
    expect(messageRecords(folded.replay)).toHaveLength(1);
  });

  it('removes replayed messages on context.undo', () => {
    const folded = fold([
      appendMessage(userMessage('first', { kind: 'user' }), 1),
      loopEvent({ type: 'step.begin', uuid: 's1' }, 2),
      loopEvent({ type: 'step.end', uuid: 's1' }, 3),
      appendMessage(userMessage('second', { kind: 'user' }), 4),
      { type: 'context.undo', count: 1, time: 5 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const [first, assistant] = messages;
    if (first?.type !== 'message' || assistant?.type !== 'message') {
      throw new Error('expected message records');
    }
    expect(first.message.content[0]).toMatchObject({ text: 'first' });
    expect(assistant.message.role).toBe('assistant');
  });

  it('keeps injection messages out of the undo walk but stops at a compaction boundary', () => {
    const compaction: WireRecord[] = [
      { type: 'full_compaction.begin', instruction: 'sum', time: 10 },
      {
        type: 'context.apply_compaction',
        summary: 'summary text',
        contextSummary: 'summary text',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 0,
        droppedCount: 0,
        time: 11,
      },
    ];
    const folded = fold([
      appendMessage(userMessage('old', { kind: 'user' }), 1),
      ...compaction,
      appendMessage(userMessage('new', { kind: 'user' }), 12),
      { type: 'context.undo', count: 1, time: 13 },
      { type: 'context.undo', count: 1, time: 14 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(1);
    const [remaining] = messages;
    if (remaining?.type !== 'message') throw new Error('expected message record');
    expect(remaining.message.content[0]).toMatchObject({ text: 'old' });
  });

  it('tracks compaction begin, apply, and cancel through the last compaction record', () => {
    const applied = fold([
      { type: 'full_compaction.begin', instruction: 'compress', time: 1 },
      {
        type: 'context.apply_compaction',
        summary: 'model summary',
        contextSummary: 'context summary',
        compactedCount: 3,
        tokensBefore: 500,
        tokensAfter: 50,
        keptUserMessageCount: 2,
        keptHeadUserMessageCount: 1,
        droppedCount: 1,
        time: 2,
      },
    ]);
    expect(applied.replay).toEqual([
      {
        type: 'compaction',
        instruction: 'compress',
        time: 1,
        result: {
          summary: 'model summary',
          contextSummary: 'context summary',
          compactedCount: 3,
          tokensBefore: 500,
          tokensAfter: 50,
          keptUserMessageCount: 2,
          keptHeadUserMessageCount: 1,
          droppedCount: 1,
        },
      },
    ]);

    const cancelled = fold([
      { type: 'full_compaction.begin', time: 1 },
      { type: 'full_compaction.cancel', time: 2 },
    ]);
    expect(cancelled.replay).toEqual([
      { type: 'compaction', instruction: undefined, time: 1, result: 'cancelled' },
    ]);

    const orphanApply = fold([
      {
        type: 'context.apply_compaction',
        summary: 's',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        time: 1,
      },
    ]);
    expect(orphanApply.replay).toEqual([]);
  });

  it('folds goal create/update/clear into goal_updated records', () => {
    const folded = fold([
      { type: 'goal.create', goalId: 'g1', objective: 'ship it', time: 1 },
      { type: 'goal.update', turnsUsed: 3, time: 2 },
      { type: 'goal.update', status: 'paused', reason: 'wait', actor: 'user', time: 3 },
      { type: 'goal.update', status: 'complete', actor: 'model', time: 4 },
      { type: 'goal.clear', time: 5 },
    ]);
    expect(folded.replay).toHaveLength(3);
    const [created, paused, completed] = folded.replay;
    expect(created).toMatchObject({
      type: 'goal_updated',
      time: 1,
      change: { kind: 'created' },
      snapshot: { goalId: 'g1', objective: 'ship it', status: 'active' },
    });
    expect(paused).toMatchObject({
      type: 'goal_updated',
      time: 3,
      change: { kind: 'lifecycle', status: 'paused', reason: 'wait', actor: 'user' },
      snapshot: { status: 'paused', turnsUsed: 3, terminalReason: 'wait' },
    });
    expect(completed).toMatchObject({
      type: 'goal_updated',
      time: 4,
      change: {
        kind: 'completion',
        status: 'complete',
        actor: 'model',
        stats: { turnsUsed: 3, tokensUsed: 0, wallClockMs: 0 },
      },
    });
  });

  it('clears the goal and appends the fork reminder on forked', () => {
    const folded = fold([
      { type: 'goal.create', goalId: 'g1', objective: 'ship it', time: 1 },
      { type: 'forked', time: 2 },
    ]);
    expect(folded.replay).toHaveLength(2);
    const reminder = folded.replay[1];
    if (reminder?.type !== 'message') throw new Error('expected message record');
    expect(reminder.message.origin).toEqual({ kind: 'system_trigger', name: 'goal_fork_cleared' });

    const noGoal = fold([{ type: 'forked', time: 1 }]);
    expect(noGoal.replay).toEqual([]);
  });

  it('folds plan, permission, approval, and config records', () => {
    const folded = fold([
      { type: 'plan_mode.enter', id: 'p1', time: 1 },
      { type: 'plan_mode.exit', id: 'p1', time: 2 },
      { type: 'plan_mode.enter', id: 'p2', time: 3 },
      { type: 'plan_mode.cancel', time: 4 },
      { type: 'permission.set_mode', mode: 'yolo', time: 5 },
      {
        type: 'permission.record_approval_result',
        turnId: 1,
        toolCallId: 'tc1',
        toolName: 'Shell',
        action: 'run',
        sessionApprovalRule: 'Shell(*)',
        result: { decision: 'approved', scope: 'session' },
        time: 6,
      },
      { type: 'config.update', modelAlias: 'k2', thinkingEffort: 'high', time: 7 },
    ]);
    expect(folded.replay).toEqual([
      { type: 'plan_updated', enabled: true, time: 1 },
      { type: 'plan_updated', enabled: false, time: 2 },
      { type: 'plan_updated', enabled: true, time: 3 },
      { type: 'plan_updated', enabled: false, time: 4 },
      { type: 'permission_updated', mode: 'yolo', time: 5 },
      {
        type: 'approval_result',
        time: 6,
        record: {
          turnId: 1,
          toolCallId: 'tc1',
          toolName: 'Shell',
          action: 'run',
          sessionApprovalRule: 'Shell(*)',
          result: { decision: 'approved', scope: 'session' },
        },
      },
      {
        type: 'config_updated',
        time: 7,
        config: {
          modelAlias: 'k2',
          profileName: undefined,
          thinkingLevel: 'high',
          systemPrompt: undefined,
        },
      },
    ]);
  });

  it('applies tools.update_store last-wins into the tool store', () => {
    const folded = fold([
      { type: 'tools.update_store', key: 'todo', value: ['a'], time: 1 },
      { type: 'tools.update_store', key: 'todo', value: ['b'], time: 2 },
      { type: 'tools.update_store', key: 'other', value: { x: 1 }, time: 3 },
    ]);
    expect(folded.replay).toEqual([]);
    expect(folded.toolStore).toEqual({ todo: ['b'], other: { x: 1 } });
  });

  it('ignores state-only, observability, and v2-only record types', () => {
    const folded = fold([
      { type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 1 },
      { type: 'usage.record', model: 'k2', usage: {}, time: 2 },
      { type: 'profile.bind', modelAlias: 'k2', disallowedTools: [], time: 3 },
      { type: 'task.started', taskId: 't1', time: 4 },
      { type: 'task.terminated', taskId: 't1', time: 5 },
      { type: 'interaction.requested', id: 'i1', time: 6 },
      { type: 'llm.request', kind: 'loop', time: 7 },
      { type: 'mcp.tools_discovered', serverName: 's', hash: 'h', time: 8 },
      { type: 'token_counting.measured', tokens: 1, time: 9 },
      { type: 'context.update_token_count', tokenCount: 10, time: 10 },
      { type: 'full_compaction.complete', time: 11 },
      { type: 'tools.set_active_tools', names: ['Shell'], time: 12 },
      { type: 'totally.unknown.op', time: 13 },
    ]);
    expect(folded).toEqual({ replay: [], toolStore: {} });
  });

  it('migrates older protocol journals before folding', () => {
    const legacy: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.0', created_at: 0 },
      appendMessage(userMessage('hi'), 3),
    ];
    const folded = foldWireRecords(legacy);
    expect(folded.replay).toHaveLength(1);
    expect(folded.replay[0]).toMatchObject({ type: 'message', time: 3 });
  });

  it('clears replay-visible state on context.clear without touching earlier replay records', () => {
    const folded = fold([
      appendMessage(userMessage('before', { kind: 'user' }), 1),
      { type: 'context.clear', time: 2 },
      appendMessage(userMessage('after', { kind: 'user' }), 3),
      { type: 'context.undo', count: 1, time: 4 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(1);
    const [remaining] = messages;
    if (remaining?.type !== 'message') throw new Error('expected message record');
    expect(remaining.message.content[0]).toMatchObject({ text: 'before' });
  });
});
