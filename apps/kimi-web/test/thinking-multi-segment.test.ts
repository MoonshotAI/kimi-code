// apps/kimi-web/test/thinking-multi-segment.test.ts
//
// A turn can think → answer → think again (and call tools in between). These
// tests stream raw agent-core events through the REAL pipeline — projector →
// reducer → messagesToTurns — and assert every thinking/text segment stays a
// separate part in call order, instead of all thinking collapsing into one
// fixed slot.

import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import { messagesToTurns } from '../src/composables/messagesToTurns';

const SESSION = 'sess_1';

/** Stream raw events through projector + reducer, returning the final state. */
function play(events: [string, unknown][]): KimiClientState {
  const projector = createAgentProjector();
  let state = createInitialState();
  let seq = 0;
  for (const [type, payload] of events) {
    for (const appEvent of projector.project(type, payload, SESSION)) {
      state = reduceAppEvent(state, appEvent, { sessionId: SESSION, seq: ++seq });
    }
  }
  return state;
}

describe('multi-segment thinking', () => {
  it('keeps interleaved thinking/text segments separate within one step', () => {
    const state = play([
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['thinking.delta', { delta: '想法A-1 ' }],
      ['thinking.delta', { delta: '想法A-2' }],
      ['assistant.delta', { delta: '回答B' }],
      ['thinking.delta', { delta: '想法C' }],
      ['assistant.delta', { delta: '回答D' }],
      ['turn.step.completed', { turnId: 1 }],
      ['turn.ended', { turnId: 1, reason: 'completed' }],
    ]);

    const msgs = state.messagesBySession[SESSION]!;
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '想法A-1 想法A-2' },
      { type: 'text', text: '回答B' },
      { type: 'thinking', thinking: '想法C' },
      { type: 'text', text: '回答D' },
    ]);
  });

  it('renders think → tool → think again as two thinking blocks in call order', () => {
    const state = play([
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['thinking.delta', { delta: '先看看文件' }],
      ['tool.call.started', { turnId: 1, toolCallId: 't1', name: 'read', args: { path: 'a.ts' } }],
      ['tool.result', { turnId: 1, toolCallId: 't1', output: 'file body', isError: false }],
      ['turn.step.started', { turnId: 1 }],
      ['thinking.delta', { delta: '看完了，组织回答' }],
      ['assistant.delta', { delta: '最终回答' }],
      ['turn.step.completed', { turnId: 1 }],
      ['turn.ended', { turnId: 1, reason: 'completed' }],
    ]);

    const turns = messagesToTurns(state.messagesBySession[SESSION]!, []);
    expect(turns).toHaveLength(1);
    const blocks = turns[0]!.blocks!;
    expect(blocks.map((b) => b.kind)).toEqual(['thinking', 'tool', 'thinking', 'text']);
    expect(blocks[0]).toEqual({ kind: 'thinking', thinking: '先看看文件' });
    expect(blocks[2]).toEqual({ kind: 'thinking', thinking: '看完了，组织回答' });
  });

  it('does not clobber already-streamed text when thinking starts afterwards', () => {
    const state = play([
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['assistant.delta', { delta: '先说一句' }],
      ['thinking.delta', { delta: '补一段思考' }],
      ['turn.step.completed', { turnId: 1 }],
      ['turn.ended', { turnId: 1, reason: 'completed' }],
    ]);

    const assistant = state.messagesBySession[SESSION]!.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'text', text: '先说一句' },
      { type: 'thinking', thinking: '补一段思考' },
    ]);
  });
});
