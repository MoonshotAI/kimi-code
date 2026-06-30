import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { project } from '../../../src/agent/context/projector';
import type { ContextMessage } from '../../../src/agent/context/types';

// ---------------------------------------------------------------------------
// Invariant under test
// ---------------------------------------------------------------------------
//
// Strict providers (Anthropic) reject a request with HTTP 400 when an assistant
// `tool_use` is not immediately followed by its matching `tool_result`. The
// projector must therefore guarantee that, for every assistant tool call whose
// result exists anywhere in the projected history, that result sits in the
// consecutive tool messages immediately following the assistant message.
//
// A tool call with no recorded result anywhere is considered still in-flight
// (pending) and is intentionally left untouched — it is not an orphan.

interface MisplacedToolUse {
  readonly assistantIndex: number;
  readonly toolCallId: string;
}

/**
 * Return tool calls whose result exists somewhere in `messages` but is not
 * adjacent to the assistant `tool_use`. An empty result means the invariant
 * holds and the history is safe to send to a strict provider.
 */
function findMisplacedToolUses(messages: readonly Message[]): MisplacedToolUse[] {
  // Index every recorded tool result by its toolCallId.
  const resultIndexById = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      resultIndexById.set(message.toolCallId, index);
    }
  });

  const violations: MisplacedToolUse[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.toolCalls.length === 0) continue;

    // Collect the toolCallIds answered in the consecutive tool messages that
    // immediately follow this assistant message.
    const adjacentResultIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const id = messages[j]!.toolCallId;
      if (id !== undefined) adjacentResultIds.add(id);
      j++;
    }

    for (const toolCall of message.toolCalls) {
      // Only flag tool calls whose result was actually recorded; a missing
      // result means the call is still in-flight, not misplaced.
      if (!resultIndexById.has(toolCall.id)) continue;
      if (!adjacentResultIds.has(toolCall.id)) {
        violations.push({ assistantIndex: i, toolCallId: toolCall.id });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function textPart(text: string): ContentPart {
  return { type: 'text', text };
}

function textOf(message: Message | undefined): string {
  return (
    message?.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('') ?? ''
  );
}

function user(text: string): ContextMessage {
  return { role: 'user', content: [textPart(text)], toolCalls: [] };
}

function notification(text: string): ContextMessage {
  return {
    role: 'user',
    content: [textPart(text)],
    toolCalls: [],
    origin: {
      kind: 'background_task',
      taskId: 'task',
      status: 'completed',
      notificationId: 'task:task:completed',
    },
  };
}

function assistant(toolCallIds: readonly string[], text = ''): ContextMessage {
  return {
    role: 'assistant',
    content: text.length > 0 ? [textPart(text)] : [],
    toolCalls: toolCallIds.map(
      (id): ToolCall => ({ type: 'function', id, name: 'Run', arguments: '{}' }),
    ),
  };
}

function emptyAssistant(): ContextMessage {
  return { role: 'assistant', content: [], toolCalls: [] };
}

function tool(toolCallId: string, text = 'ok'): ContextMessage {
  return { role: 'tool', content: [textPart(text)], toolCalls: [], toolCallId };
}

function compactionSummary(text = 'summary'): ContextMessage {
  return {
    role: 'assistant',
    content: [textPart(text)],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

// ---------------------------------------------------------------------------
// Targeted regression tests
// ---------------------------------------------------------------------------

describe('project tool_use/tool_result adjacency', () => {
  it('leaves an already well-formed history unchanged (idempotent)', () => {
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      tool('a'),
      user('u2'),
      assistant(['b', 'c']),
      tool('b'),
      tool('c'),
      user('u3'),
    ];
    const projected = project(history);
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'b'],
      ['tool', 'c'],
      ['user', undefined],
    ]);
    expect(findMisplacedToolUses(projected)).toEqual([]);
  });

  it('moves a user message sandwiched between tool_use and tool_result to after the result', () => {
    const history: ContextMessage[] = [user('u1'), assistant(['a']), notification('ping'), tool('a')];
    const projected = project(history);
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(projected[1]?.toolCalls.map((tc) => tc.id)).toEqual(['a']);
    expect(projected[2]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    expect(findMisplacedToolUses(projected)).toEqual([]);
  });

  it('pulls a distant tool result back up across intervening exchanges', () => {
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      user('middle'),
      assistant(['b']),
      tool('b'),
      user('later'),
      tool('a'),
    ];
    const projected = project(history);
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'b'],
      ['user', undefined],
    ]);
    expect(findMisplacedToolUses(projected)).toEqual([]);
  });

  it('reorders parallel tool results that arrive out of order', () => {
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a', 'b', 'c']),
      tool('c'),
      tool('a'),
      tool('b'),
    ];
    const projected = project(history);
    // All three results must be adjacent to the assistant, regardless of order.
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool']);
    const resultIds = projected.slice(2).map((m) => m.toolCallId);
    expect(resultIds).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(findMisplacedToolUses(projected)).toEqual([]);
  });

  it('repairs multiple misplaced exchanges in a single history', () => {
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      user('sandwich-a'),
      assistant(['b']),
      tool('b'),
      user('sandwich-b'),
      tool('a'),
    ];
    const projected = project(history);
    expect(findMisplacedToolUses(projected)).toEqual([]);
    // a's result must immediately follow a's assistant.
    const aIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'a'));
    expect(projected[aIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    const bIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'b'));
    expect(projected[bIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'b' });
  });

  it('leaves a pending (in-flight) tool call without a recorded result untouched', () => {
    const history: ContextMessage[] = [user('u1'), assistant(['a', 'b']), tool('a')];
    // b has no recorded result — it is still pending, not orphaned.
    const projected = project(history);
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
    ]);
    // No new (synthetic) tool result for b was introduced.
    expect(projected.some((m) => m.toolCallId === 'b')).toBe(false);
  });

  it('synthesizes a tool result for a missing tool call when synthesizeMissing is set', () => {
    const history: ContextMessage[] = [user('u1'), assistant(['a', 'b']), tool('a')];
    const projected = project(history, { synthesizeMissing: true });
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['tool', 'b'],
    ]);
    expect(projected.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'b' });
    expect(findMisplacedToolUses(projected)).toEqual([]);
  });

  // Regression for the full-compaction prefix gap: a delayed tool result may be
  // sliced out of the compacted prefix (the split is computed on the raw,
  // misordered history). With synthesizeMissing the sliced projection must still
  // close the exchange so the summary request is not rejected.
  it('closes a tool call whose delayed result is sliced out of a compaction prefix', () => {
    const fullHistory: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      user('middle'),
      assistant(['b']),
      tool('b'),
      user('later'),
      tool('a'),
    ];
    // The strategy may split after tool('b'), excluding the distant tool('a').
    const prefix = fullHistory.slice(0, 5);
    const projected = project(prefix, { synthesizeMissing: true });
    expect(findMisplacedToolUses(projected)).toEqual([]);
    const aIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'a'));
    expect(projected[aIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    // The synthesized result carries the placeholder text, not the real output.
    expect(textOf(projected[aIndex + 1])).toContain('not available');
  });

  it('does not move a tool result whose toolCallId matches no assistant tool_use', () => {
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      tool('a'),
      tool('orphan-result'),
      user('u2'),
    ];
    const projected = project(history);
    // The stray result stays where it was; nothing references it.
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['tool', 'orphan-result'],
      ['user', undefined],
    ]);
  });

  it('does not crash when a tool result appears before its tool_use', () => {
    const history: ContextMessage[] = [tool('a'), user('u1'), assistant(['a'])];
    // Forward scan cannot find the result (it is behind the assistant), so the
    // exchange is left as-is rather than throwing.
    expect(() => project(history)).not.toThrow();
  });

  it('preserves compaction summaries and empty assistants while repairing', () => {
    const history: ContextMessage[] = [
      compactionSummary(),
      user('u1'),
      assistant(['a']),
      notification('ping'),
      emptyAssistant(),
      tool('a'),
    ];
    const projected = project(history);
    expect(findMisplacedToolUses(projected)).toEqual([]);
    const aIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'a'));
    expect(projected[aIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'a' });
  });
});

// ---------------------------------------------------------------------------
// Property-based fuzz test
// ---------------------------------------------------------------------------
//
// Generate a large number of histories with randomized, worst-case misordering
// (sandwiched user messages, distant results, parallel calls, pending calls,
// empty assistants, compaction summaries) and assert the projector ALWAYS
// produces a history that satisfies the adjacency invariant. This is the guard
// that catches regressions which would otherwise strand the user with HTTP 400.

describe('project adjacency invariant (fuzz)', () => {
  it('holds for thousands of randomized histories', () => {
    const rng = mulberry32(0x5eed_c0de);
    const iterations = 4000;
    for (let n = 0; n < iterations; n++) {
      const history = generateHistory(rng, n);
      const projected = project(history);
      const violations = findMisplacedToolUses(projected);
      expect(
        violations,
        `adjacency invariant violated at iteration ${n}\n` +
          `history:   ${JSON.stringify(history.map(label))}\n` +
          `projected: ${JSON.stringify(projected.map(label))}`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz generator
// ---------------------------------------------------------------------------

type Rng = () => number;

function label(message: Message): string {
  const id = message.toolCallId ?? message.toolCalls.map((toolCall) => toolCall.id).join(',');
  return `${message.role}:${id}`;
}

// mulberry32 requires unsigned 32-bit wrapping arithmetic (`>>> 0`), which
// `Math.trunc` does not provide, so the prefer-math-trunc lint is a false
// positive here.
/* eslint-disable unicorn/prefer-math-trunc */
function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* eslint-enable unicorn/prefer-math-trunc */

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function generateHistory(rng: Rng, seed: number): ContextMessage[] {
  const messages: ContextMessage[] = [];
  let nextId = 1;
  const blockCount = 2 + Math.floor(rng() * 8);

  for (let b = 0; b < blockCount; b++) {
    const kind = pick(rng, ['user', 'exchange', 'notification', 'empty', 'compaction'] as const);
    switch (kind) {
      case 'user':
        messages.push(user(`u-${seed}-${b}`));
        break;
      case 'notification':
        messages.push(notification(`n-${seed}-${b}`));
        break;
      case 'empty':
        messages.push(emptyAssistant());
        break;
      case 'compaction':
        messages.push(compactionSummary());
        break;
      case 'exchange': {
        const arity = 1 + Math.floor(rng() * 3);
        const ids: string[] = [];
        for (let k = 0; k < arity; k++) {
          ids.push(`c${nextId++}`);
        }
        messages.push(assistant(ids));
        // Decide which results are recorded (some may be pending).
        const recorded = ids.filter(() => rng() > 0.25);
        // Randomize result order to simulate parallel calls completing out of order.
        shuffle(recorded, rng);
        // Randomly inject a sandwiched user/notification before the results.
        if (rng() > 0.5) {
          messages.push(pick(rng, [user(`sandwich-${seed}-${b}`), notification(`sandwich-n-${seed}-${b}`)]));
        }
        // Randomly delay one recorded result past a following exchange.
        let delayed: ContextMessage | undefined;
        if (recorded.length > 0 && rng() > 0.6) {
          delayed = tool(recorded.pop()!);
        }
        for (const id of recorded) {
          messages.push(tool(id));
        }
        // Possibly emit a full extra exchange before the delayed result lands.
        if (delayed !== undefined) {
          if (rng() > 0.4) {
            const laterIds = [`c${nextId++}`];
            messages.push(assistant(laterIds));
            messages.push(tool(laterIds[0]!));
          }
          messages.push(delayed);
        }
        break;
      }
    }
  }
  return messages;
}

function shuffle<T>(items: T[], rng: Rng): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
