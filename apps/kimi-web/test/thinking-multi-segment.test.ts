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
import type { AppMessage } from '../src/api/types';

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

  it('keeps ReadMediaFile media available for direct rendering', () => {
    const output = [
      { type: 'text', text: '<system>Read image file. Mime type: image/png. Size: 67 bytes. Original dimensions: 1x1 pixels.</system>' },
      { type: 'text', text: '<image path="/tmp/before.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } },
      { type: 'text', text: '</image>' },
    ];
    const state = play([
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['tool.call.started', { turnId: 1, toolCallId: 't1', name: 'ReadMediaFile', args: { path: '/tmp/before.png' } }],
      ['tool.result', { turnId: 1, toolCallId: 't1', output, isError: false }],
      ['turn.step.completed', { turnId: 1 }],
      ['turn.ended', { turnId: 1, reason: 'completed' }],
    ]);

    const turns = messagesToTurns(state.messagesBySession[SESSION]!, []);
    const block = turns[0]!.blocks!.find((b) => b.kind === 'tool');
    expect(block).toMatchObject({
      kind: 'tool',
      tool: {
        name: 'ReadMediaFile',
        media: {
          kind: 'image',
          url: 'data:image/png;base64,aGVsbG8=',
          path: '/tmp/before.png',
          mimeType: 'image/png',
          bytes: 5,
          dimensions: '1x1',
        },
      },
    });
  });

  it('keeps live bash progress on the running tool call without auto-expanding it', () => {
    const state = play([
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['tool.call.started', { turnId: 1, toolCallId: 't1', name: 'bash', args: { command: 'pnpm test' } }],
      ['tool.progress', { toolCallId: 't1', update: { kind: 'stdout', text: 'running tests\n' } }],
    ]);

    const turns = messagesToTurns(state.messagesBySession[SESSION]!, []);
    const block = turns[0]!.blocks!.find((b) => b.kind === 'tool');
    expect(block).toMatchObject({
      kind: 'tool',
      tool: {
        id: 't1',
        name: 'bash',
        status: 'running',
        output: ['running tests\n'],
      },
    });
    if (block?.kind !== 'tool') throw new Error('expected a tool block');
    expect(block.tool.defaultExpanded).toBeUndefined();
  });
});

describe('snapshot turn grouping', () => {
  function message(
    id: string,
    role: AppMessage['role'],
    content: AppMessage['content'],
    promptId?: string,
  ): AppMessage {
    return {
      id,
      sessionId: SESSION,
      role,
      content,
      createdAt: '2026-06-12T00:00:00.000Z',
      promptId,
    };
  }

  it('merges adjacent assistant snapshot messages when promptId is missing', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hi' }]),
        message('a1', 'assistant', [{ type: 'thinking', thinking: 'inspect' }]),
        message('a2', 'assistant', [
          { type: 'toolUse', toolCallId: 't1', toolName: 'Read', input: { path: 'a.ts' } },
        ]),
        message('t1-result', 'tool', [
          { type: 'toolResult', toolCallId: 't1', output: 'file body' },
        ]),
        message('a3', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
    );

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    const assistant = turns[1]!;
    expect(assistant.blocks?.map((block) => block.kind)).toEqual(['thinking', 'tool', 'text']);
    expect(assistant.blocks?.[1]).toMatchObject({
      kind: 'tool',
      tool: {
        id: 't1',
        status: 'ok',
        output: ['file body'],
      },
    });
    expect(assistant.text).toBe('done');
    expect(assistant.thinking).toBe('inspect');
  });

  it('keeps adjacent assistant messages separate when promptIds disagree', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'first' }], 'prompt_1'),
        message('a2', 'assistant', [{ type: 'text', text: 'second' }], 'prompt_2'),
      ],
      [],
    );

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.text)).toEqual(['first', 'second']);
  });
});

describe('prompt.submitted projection', () => {
  it('creates the user message for a prompt sent by another client', () => {
    const state = play([
      [
        'prompt.submitted',
        {
          promptId: 'prompt_1',
          userMessageId: 'msg_user_1',
          status: 'running',
          content: [{ type: 'text', text: 'hello from another client' }],
          createdAt: '2026-06-11T00:00:00.000Z',
        },
      ],
      ['turn.started', { turnId: 1 }],
      ['turn.step.started', { turnId: 1 }],
      ['assistant.delta', { delta: 'received' }],
      ['turn.step.completed', { turnId: 1 }],
      ['turn.ended', { turnId: 1, reason: 'completed' }],
    ]);

    const messages = state.messagesBySession[SESSION]!;
    expect(messages[0]).toMatchObject({
      id: 'msg_user_1',
      sessionId: SESSION,
      role: 'user',
      promptId: 'prompt_1',
      content: [{ type: 'text', text: 'hello from another client' }],
      createdAt: '2026-06-11T00:00:00.000Z',
    });
    expect(messages.find((message) => message.role === 'assistant')?.promptId).toBe('prompt_1');
  });
});
