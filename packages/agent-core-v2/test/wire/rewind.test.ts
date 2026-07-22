import { describe, expect, it } from 'vitest';

import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import { contextAppendMessage, ContextModel } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { TurnModel } from '#/agent/loop/turnOps';
import { promptTurn } from '#/agent/loop/turnOps';
import { TurnIndexModel } from '#/agent/loop/turnIndexOps';
import { TodoModel, todoSet } from '#/session/todo/todoOps';
import { WireError } from '#/wire/errors';
import { LOG_CUT_RECORD_TYPE, type WireRecord } from '#/wire/record';

import { recordingWireLog, registerTestAgentWire } from './stubs';

const SCOPE = 'wire/rewind-test';

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function promptRecord(text: string) {
  return promptTurn({ input: [{ type: 'text', text }], origin: { kind: 'user' } });
}

function buildHost(records: WireRecord[] = []) {
  const disposables = new DisposableStore();
  const ix = createServices(disposables);
  const wire = registerTestAgentWire(ix, SCOPE, { log: recordingWireLog(records) });
  return { disposables, ix, wire, records };
}

describe('WireService rewind (log.cut)', () => {
  it('rebuilds rewindable models to the cut and preserves world-time models', async () => {
    const { wire, records } = buildHost();
    // Journal: turn.prompt(0), user(1), todo(2), turn.prompt(3), user(4), todo(5)
    wire.dispatch(promptRecord('u1'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u1') }));
    wire.dispatch(todoSet({ key: 'todo', value: [{ title: 'from turn 1', status: 'pending' }] }));
    wire.dispatch(promptRecord('u2'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u2') }));
    wire.dispatch(todoSet({ key: 'todo', value: [{ title: 'from turn 2', status: 'pending' }] }));

    // Cut at the second turn's prompt (record index 3).
    await wire.rewind(3, 'undo');

    // Rewindable: context and todo rebuilt from [0, 3).
    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1')]);
    expect(wire.getModel(TodoModel)).toEqual([{ title: 'from turn 1', status: 'pending' }]);
    expect(wire.getModel(TurnIndexModel).turnStarts).toEqual([0]);
    // World-time: the turn counter never rewinds.
    expect(wire.getModel(TurnModel).nextTurnId).toBe(2);
    // The cut record was appended and occupies the next index.
    expect(records.map((r) => r.type)).toEqual([
      'turn.prompt',
      'context.append_message',
      'tools.update_store',
      'turn.prompt',
      'context.append_message',
      'tools.update_store',
      LOG_CUT_RECORD_TYPE,
    ]);
    expect(records[6]).toMatchObject({ target: 3, reason: 'undo' });

    // State after the cut accepts new turns on top of the rebuilt base.
    wire.dispatch(promptRecord('u3'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u3') }));
    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1'), userMessage('u3')]);
    expect(wire.getModel(TurnIndexModel).turnStarts).toEqual([0, 7]);
  });

  it('restore of a journal with log.cut produces the post-rewind state', async () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'u1' }], origin: { kind: 'user' } },
      { type: 'context.append_message', message: userMessage('u1') },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'u2' }], origin: { kind: 'user' } },
      { type: 'context.append_message', message: userMessage('u2') },
      { type: 'log.cut', target: 2, reason: 'undo' },
    ];
    const { wire } = buildHost(records);
    await wire.restore();

    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1')]);
    expect(wire.getModel(TurnIndexModel).turnStarts).toEqual([0]);
    expect(wire.getModel(TurnModel).nextTurnId).toBe(2);
  });

  it('handles nested cuts: a later cut whose range contains an earlier cut', async () => {
    const { wire } = buildHost();
    wire.dispatch(promptRecord('u1'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u1') }));
    wire.dispatch(promptRecord('u2'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u2') }));
    // Cut away u2 (records 0..3, cut at 4 targeting 2).
    await wire.rewind(2, 'undo');
    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1')]);

    wire.dispatch(promptRecord('u3'));
    wire.dispatch(contextAppendMessage({ message: userMessage('u3') }));
    // Journal: prompt(0), user(1), prompt(2), user(3), cut(4→2), prompt(5), user(6)
    // Cut away everything from the second turn's prompt onward (record 2).
    await wire.rewind(2, 'undo');
    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1')]);
    expect(wire.getModel(TurnIndexModel).turnStarts).toEqual([0]);
  });

  it('still replays legacy context.undo records (pre-rewind journals)', async () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      { type: 'context.append_message', message: userMessage('u1') },
      { type: 'context.append_message', message: userMessage('u2') },
      { type: 'context.undo', count: 1 },
    ];
    const { wire } = buildHost(records);
    await wire.restore();
    expect(wire.getModel(ContextModel)).toEqual([userMessage('u1')]);
  });

  it('rejects an out-of-bounds target and a re-entrant rewind', async () => {
    const { wire } = buildHost();
    wire.dispatch(promptRecord('u1'));

    await expect(wire.rewind(-1)).rejects.toThrow(WireError);
    await expect(wire.rewind(2)).rejects.toThrow(WireError);

    const first = wire.rewind(1, 'undo');
    await expect(wire.rewind(1, 'undo')).rejects.toThrow(/re-entered/);
    await first;
    expect(wire.getModel(TurnIndexModel).turnStarts).toEqual([0]);
  });
});
