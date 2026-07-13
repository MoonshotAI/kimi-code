/**
 * `InFlightTurnTracker` — volatile accumulation + delta offsets.
 */

import type { Event } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { InFlightTurnTracker } from '../src/transport/ws/v1/inFlightTurnTracker';

const SID = 'sess_1';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: SID, ...partial } as unknown as Event;
}

describe('InFlightTurnTracker', () => {
  it('accumulates assistant text and reports pre-append offsets', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));

    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }))).toEqual({
      offset: 0,
    });
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: ' world' }))).toEqual({
      offset: 5,
    });

    expect(t.get(SID)).toMatchObject({ turn_id: 1, assistant_text: 'Hello world' });
  });

  it('tracks thinking offsets independently', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    expect(t.apply(SID, ev({ type: 'thinking.delta', turnId: 1, delta: 'abc' }))).toEqual({
      offset: 0,
    });
    expect(t.apply(SID, ev({ type: 'thinking.delta', turnId: 1, delta: 'de' }))).toEqual({
      offset: 3,
    });
    expect(t.get(SID)).toMatchObject({ assistant_text: '', thinking_text: 'abcde' });
  });

  it('clears on turn.ended', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'assistant.delta', turnId: 1, delta: 'x' }));
    t.apply(SID, ev({ type: 'turn.ended', turnId: 1 }));
    expect(t.get(SID)).toBeNull();
  });

  it('ignores non-main agents', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    const sub = { agentId: 'agent-sub', sessionId: SID, type: 'assistant.delta', turnId: 1, delta: 'nope' } as unknown as Event;
    expect(t.apply(SID, sub)).toEqual({});
    expect(t.get(SID)?.assistant_text).toBe('');
  });

  it('ignores deltas for a mismatched turn', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    expect(t.apply(SID, ev({ type: 'assistant.delta', turnId: 99, delta: 'stale' }))).toEqual({});
    expect(t.get(SID)?.assistant_text).toBe('');
  });

  it('tracks running tools and their last progress', () => {
    const t = new InFlightTurnTracker();
    t.apply(SID, ev({ type: 'turn.started', turnId: 1 }));
    t.apply(SID, ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'tc1', name: 'bash' }));
    t.apply(
      SID,
      ev({ type: 'tool.progress', turnId: 1, toolCallId: 'tc1', update: { kind: 'stdout', text: 'hi' } }),
    );
    expect(t.get(SID)?.running_tools).toEqual([
      { tool_call_id: 'tc1', name: 'bash', last_progress: { kind: 'stdout', text: 'hi' } },
    ]);
    t.apply(SID, ev({ type: 'tool.result', turnId: 1, toolCallId: 'tc1' }));
    expect(t.get(SID)?.running_tools).toEqual([]);
  });
});
