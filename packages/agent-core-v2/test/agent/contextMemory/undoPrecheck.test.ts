import { describe, expect, it } from 'vitest';

import { cutTurnUndo, wireLinesOf } from '#/agent/undo/turnUndo';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

function prompt(value = 'u', origin: PromptOrigin = { kind: 'user' }): WireRecord {
  return {
    type: 'turn.prompt',
    input: [text(value)],
    origin,
    promptId: value,
    turnId: 0,
    trigger: 'normal',
  };
}

function user(origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [text('u')],
    ...(origin === undefined ? {} : { origin }),
  };
}

function append(message: ContextMessage): WireRecord {
  return { type: 'context.append_message', message };
}

function assistant(): ContextMessage {
  return { role: 'assistant', content: [text('a')], toolCalls: [] };
}

function injection(): ContextMessage {
  return {
    role: 'user',
    content: [text('i')],
    origin: { kind: 'injection', variant: 'system_reminder' },
  };
}

function compaction(): WireRecord {
  return { type: 'context.apply_compaction', summary: 'summary', compactedCount: 2 };
}

describe('cutTurnUndo', () => {
  it('finds the cut for the last real turn prompt', () => {
    const records = [
      append({ ...user({ kind: 'user' }), id: 'u' }),
      prompt(),
      { type: 'turn.steer', input: [text('steer')], origin: { kind: 'user' }, turnId: 0 },
      append(assistant()),
    ];
    const result = cutTurnUndo(wireLinesOf(records), new Set(), 1);
    expect(result.anchors.map((anchor) => anchor.turnId)).toEqual([0, 1]);
    expect(result.cut).toMatchObject({ index: 2, line: 2 });
  });

  it('skips trailing non-turn records while scanning', () => {
    const result = cutTurnUndo(wireLinesOf([prompt(), append(assistant()), append(assistant())]), new Set(), 1);
    expect(result.cut?.line).toBe(0);
  });

  it('treats a turn prompt without origin as a real prompt', () => {
    const record: WireRecord = { type: 'turn.prompt', input: [text('legacy')], promptId: 'legacy' };
    const result = cutTurnUndo(wireLinesOf([record, append(assistant())]), new Set(), 1);
    expect(result.cut?.line).toBe(0);
  });

  it('does not treat context-only user messages as turn starts', () => {
    const result = cutTurnUndo(wireLinesOf([append(user({ kind: 'user' }))]), new Set(), 1);
    expect(result.anchors).toHaveLength(0);
    expect(result.cut).toBeUndefined();
  });

  it('skips injections and continuation prompts without counting them', () => {
    const records = [
      append(injection()),
      { type: 'turn.prompt', input: [], origin: { kind: 'user' }, trigger: 'continue' },
      append(assistant()),
    ];
    const result = cutTurnUndo(wireLinesOf(records), new Set(), 1);
    expect(result.anchors).toHaveLength(0);
    expect(result.cut).toBeUndefined();
  });

  it('does not cut when fewer turn prompts exist than requested', () => {
    const result = cutTurnUndo(wireLinesOf([prompt('u1'), append(assistant()), prompt('u2'), append(assistant())]), new Set(), 3);
    expect(result.anchors).toHaveLength(2);
    expect(result.cut).toBeUndefined();
  });

  it('stops at a compaction boundary', () => {
    const result = cutTurnUndo(wireLinesOf([prompt(), compaction(), append(assistant())]), new Set(), 1);
    expect(result.anchors).toHaveLength(0);
    expect(result.stoppedAtCompaction).toBe(true);
    expect(result.cut).toBeUndefined();
  });

  it('keeps only prompts after compaction available', () => {
    const records = [prompt('before'), compaction(), prompt('after'), append(assistant())];
    const result = cutTurnUndo(wireLinesOf(records), new Set(), 2);
    expect(result.anchors).toHaveLength(1);
    expect(result.stoppedAtCompaction).toBe(true);
    expect(result.cut).toBeUndefined();
    expect(cutTurnUndo(wireLinesOf(records), new Set(), 1).cut?.line).toBe(2);
  });
});
