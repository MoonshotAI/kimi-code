import { produce } from 'immer';
import { describe, expect, it } from 'vitest';

import { ContextAppendLoopEvent } from '#/agent/contextMemory/contextEvents';
import type { Event2, Event2Class } from '#/app/event/event2';
import type { FoldContext } from '#/state/state';
import {
  TurnCancel,
  TurnEnded,
  turnKey,
  TurnPrompt,
  type TurnModelState,
} from '#/agent/loop/turnOps';

const foldContext: FoldContext = {
  silent: false,
  checkpoint: () => {},
  clearCheckpoints: () => {},
  undoToCheckpoint: () => {},
  emit: () => {},
};

function fold(s: TurnModelState, event: Event2): TurnModelState {
  const entry = turnKey.replayable.folds.get(event.constructor as Event2Class);
  if (entry === undefined) throw new Error(`turn model fold not registered for '${event.type}'`);
  return produce(s, (draft) => entry(draft, event, foldContext) as void);
}

function foldLoopEvent(s: TurnModelState, turnId: string): TurnModelState {
  return fold(s, new ContextAppendLoopEvent({ agentId: 'main', event: { type: 'step.begin', uuid: 'step-0', turnId } }));
}

describe('turnKey lastEnded', () => {
  it('keeps the stored outcome across prompts and queued cancels', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ agentId: 'main', turnId: 0, reason: 'failed', durationMs: 10 }));
    expect(s.lastEnded).toMatchObject({ turnId: 0, reason: 'failed' });
    s = fold(s, new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } }));
    expect(s.lastEnded?.reason).toBe('failed');
    s = fold(s, new TurnCancel({ agentId: 'main', turnId: 1, target: 'queued' }));
    expect(s.lastEnded?.reason).toBe('failed');
    s = fold(s, new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
    expect(s.lastEnded).toMatchObject({ turnId: 1, reason: 'completed' });
  });

  it('clears the stored outcome once a newer turn starts producing', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } }));
    s = fold(s, new TurnEnded({ agentId: 'main', turnId: 0, reason: 'failed' }));
    s = fold(s, new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } }));
    s = foldLoopEvent(s, '1');
    expect(s.lastEnded).toBeUndefined();
  });

  it('keeps the stored outcome on the same turn’s own events', () => {
    let s = turnKey.initial();
    s = fold(s, new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' } }));
    s = foldLoopEvent(s, '0');
    s = fold(s, new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }));
    s = foldLoopEvent(s, '0');
    expect(s.lastEnded?.reason).toBe('completed');
  });

  it('starts without a stored outcome', () => {
    expect(turnKey.initial().lastEnded).toBeUndefined();
  });
});

describe('TurnEnded serialization', () => {
  it('emits the op record shape without the bus-only interruptReason', () => {
    const event = new TurnEnded(
      {
        agentId: 'main',
        turnId: 3,
        reason: 'cancelled',
        durationMs: 12,
        interruptReason: 'user_cancelled',
      },
      42,
    );
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      agentId: 'main',
      turnId: 3,
      reason: 'cancelled',
      durationMs: 12,
      time: 42,
    });
  });

  it('omits absent optional fields from the record', () => {
    const event = new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }, 7);
    expect(event.serialize()).toEqual({
      type: 'turn.ended',
      agentId: 'main',
      turnId: 0,
      reason: 'completed',
      time: 7,
    });
  });
});
