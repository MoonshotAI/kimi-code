import type { ContentPart, Message, ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { project, type ProjectionAnomaly } from '../../../src/agent/context/projector';
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
// A tool call with no recorded result anywhere is closed with a synthetic
// `tool_result` when a later turn follows it (it cannot be in-flight). Only the
// trailing exchange's missing result is left untouched — there the call is
// genuinely still pending.

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

/**
 * Strict wire-compliance check: every assistant `tool_use` must be answered by a
 * `tool_result` in the consecutive tool messages immediately following it. Use
 * only where no trailing in-flight call is expected — an in-flight call has no
 * result by design and would (correctly) fail this check.
 */
function everyToolUseImmediatelyAnswered(messages: readonly Message[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.toolCalls.length === 0) continue;
    const adjacentResultIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const id = messages[j]!.toolCallId;
      if (id !== undefined) adjacentResultIds.add(id);
      j++;
    }
    if (message.toolCalls.some((toolCall) => !adjacentResultIds.has(toolCall.id))) {
      return false;
    }
  }
  return true;
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
    // b has no recorded result — it is the trailing exchange, still in-flight.
    const projected = project(history);
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
    ]);
    // No new (synthetic) tool result for b was introduced.
    expect(projected.some((m) => m.toolCallId === 'b')).toBe(false);
  });

  it('synthesizes a result for a mid-history tool call whose result is missing entirely', () => {
    // 'a' has no recorded result anywhere, but a later turn (u2 / assistant b)
    // proves the model already moved on — the call cannot be in-flight, so it is
    // a genuine orphan that strict providers reject. It must be closed in place.
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      user('u2'),
      assistant(['b']),
      tool('b'),
    ];
    const projected = project(history);
    const aIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'a'));
    expect(projected[aIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    expect(textOf(projected[aIndex + 1])).toContain('not available');
    expect(findMisplacedToolUses(projected)).toEqual([]);
    // No assistant tool_use is left unanswered for a strict provider.
    expect(everyToolUseImmediatelyAnswered(projected)).toBe(true);
  });

  it('closes a mid-history orphan while leaving the trailing in-flight call untouched', () => {
    // 'a' is a mid-history orphan (a later turn follows); 'b' is the trailing
    // exchange whose result is genuinely still pending.
    const history: ContextMessage[] = [
      user('u1'),
      assistant(['a']),
      user('u2'),
      assistant(['b']),
    ];
    const projected = project(history);
    const aIndex = projected.findIndex((m) => m.toolCalls.some((tc) => tc.id === 'a'));
    expect(projected[aIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    // The trailing in-flight call 'b' is not closed with a synthetic result.
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
    // Without dropOrphanResults (fragment projections, e.g. token estimation)
    // the stray result stays where it was; nothing references it.
    const projected = project(history);
    expect(projected.map((m) => [m.role, m.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'a'],
      ['tool', 'orphan-result'],
      ['user', undefined],
    ]);
    // Request-building projections enable dropOrphanResults and remove it.
    const wire = project(history, { dropOrphanResults: true });
    expect(wire.some((m) => m.toolCallId === 'orphan-result')).toBe(false);
    expect(wire.some((m) => m.toolCallId === 'a')).toBe(true);
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
// Repair reporting (onAnomaly)
// ---------------------------------------------------------------------------

describe('project repair reporting', () => {
  it('reports nothing for an already well-formed history', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project([user('u1'), assistant(['a']), tool('a'), user('u2')], {
      onAnomaly: (a) => anomalies.push(a),
    });
    expect(anomalies).toEqual([]);
  });

  it('reports a displaced result that had to be moved up', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project([user('u1'), assistant(['a']), notification('ping'), tool('a')], {
      onAnomaly: (a) => anomalies.push(a),
    });
    expect(anomalies).toEqual([{ kind: 'tool_result_reordered', toolCallId: 'a' }]);
  });

  it('does not report adjacent parallel results that are merely out of order', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project([user('u1'), assistant(['a', 'b', 'c']), tool('c'), tool('a'), tool('b')], {
      onAnomaly: (a) => anomalies.push(a),
    });
    expect(anomalies).toEqual([]);
  });

  it('reports a mid-history synthesis as a non-trailing (defect) repair', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project([user('u1'), assistant(['a']), user('u2'), assistant(['b']), tool('b')], {
      onAnomaly: (a) => anomalies.push(a),
    });
    expect(anomalies).toEqual([
      { kind: 'tool_result_synthesized', toolCallId: 'a', trailing: false },
    ]);
  });

  it('marks a forced trailing synthesis as trailing (expected, not a defect)', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project([user('u1'), assistant(['a', 'b']), tool('a')], {
      synthesizeMissing: true,
      onAnomaly: (a) => anomalies.push(a),
    });
    expect(anomalies).toEqual([
      { kind: 'tool_result_synthesized', toolCallId: 'b', trailing: true },
    ]);
  });

  it('reports a dropped orphan result when dropOrphanResults is set', () => {
    const history: ContextMessage[] = [user('u1'), assistant(['a']), tool('a'), tool('stray')];
    // Fragment projections (no flag) leave the stray in place and report nothing.
    const fragment: ProjectionAnomaly[] = [];
    project(history, { onAnomaly: (a) => fragment.push(a) });
    expect(fragment).toEqual([]);

    // Request-building projections (normal wire, strict resend, summarizer)
    // enable the flag, drop the stray, and surface the repair.
    const wire: ProjectionAnomaly[] = [];
    project(history, { dropOrphanResults: true, onAnomaly: (a) => wire.push(a) });
    expect(wire).toEqual([{ kind: 'orphan_tool_result_dropped', toolCallId: 'stray' }]);
  });

  it('reports a whitespace-only text drop but not a truly-empty one', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project(
      [
        // empty '' block (routine) followed by real text — not reported
        { role: 'user', content: [textPart(''), textPart('hi')], toolCalls: [] },
        // whitespace-only block dropped — reported
        { role: 'assistant', content: [textPart('  \n'), textPart('ok')], toolCalls: [] },
      ],
      { onAnomaly: (a) => anomalies.push(a) },
    );
    expect(anomalies).toEqual([{ kind: 'whitespace_text_dropped', role: 'assistant' }]);
  });

  it('reports leading-non-user drops and consecutive-assistant merges (strict)', () => {
    const anomalies: ProjectionAnomaly[] = [];
    project(
      [
        { role: 'assistant', content: [textPart('opener')], toolCalls: [] },
        user('hi'),
        { role: 'assistant', content: [textPart('one')], toolCalls: [] },
        { role: 'assistant', content: [textPart('two')], toolCalls: [] },
      ],
      { dropLeadingNonUser: true, mergeConsecutiveAssistants: true, onAnomaly: (a) => anomalies.push(a) },
    );
    expect(anomalies).toContainEqual({ kind: 'consecutive_assistants_merged' });
    expect(anomalies).toContainEqual({ kind: 'leading_non_user_dropped', role: 'assistant' });
  });
});

// ---------------------------------------------------------------------------
// Whitespace-only text + strict-provider sanitizers
// ---------------------------------------------------------------------------

function ws(text: string): ContextMessage {
  return { role: 'user', content: [textPart(text)], toolCalls: [] };
}

function assistantText(text: string): ContextMessage {
  return { role: 'assistant', content: [textPart(text)], toolCalls: [] };
}

describe('project drops whitespace-only text', () => {
  it('drops a text block that is only whitespace (Anthropic rejects it)', () => {
    const projected = project([
      user('real'),
      {
        role: 'assistant',
        content: [textPart('   '), textPart('answer')],
        toolCalls: [],
      },
    ]);
    const assistantMsg = projected.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('drops a message whose only text block is whitespace', () => {
    const projected = project([user('real'), ws('   \n\t ')]);
    expect(projected.map((m) => textOf(m))).toEqual(['real']);
  });

  it('keeps surrounding whitespace inside a non-empty block', () => {
    const projected = project([user('  hello  ')]);
    expect(textOf(projected[0])).toBe('  hello  ');
  });
});

describe('project strict-provider sanitizers', () => {
  it('drops leading non-user messages so the first message is a user turn', () => {
    // History that (pathologically) starts with an assistant turn.
    const projected = project(
      [assistantText('stray opener'), user('hi'), assistant(['a']), tool('a')],
      { dropLeadingNonUser: true },
    );
    expect(projected[0]?.role).toBe('user');
    expect(textOf(projected[0])).toBe('hi');
  });

  it('only drops leading non-user under the strict flag (normal path keeps them)', () => {
    const history: ContextMessage[] = [assistantText('stray opener'), user('hi')];
    expect(project(history)[0]?.role).toBe('assistant');
    expect(project(history, { dropLeadingNonUser: true })[0]?.role).toBe('user');
  });

  it('merges consecutive assistant messages under the strict flag', () => {
    const projected = project([user('hi'), assistantText('part one'), assistantText('part two')], {
      mergeConsecutiveAssistants: true,
    });
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(projected[1])).toContain('part one');
    expect(textOf(projected[1])).toContain('part two');
  });

  it('leaves consecutive assistant messages untouched on the normal path', () => {
    const projected = project([user('hi'), assistantText('part one'), assistantText('part two')]);
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
  });
});

describe('project duplicate tool_use ids', () => {
  // A provider that (buggily, or via per-response counter ids like `call_0`)
  // emits two tool_use blocks with the same id produces a request strict
  // providers reject ("`tool_use` ids must be unique"). The normal projection
  // must leave the duplicates untouched — the lax provider that produced them
  // accepts them, and deduping would silently erase its later tool exchanges.
  // Only the strict resend (after a provider already rejected the request)
  // dedupes, dropping later duplicate calls together with their recorded
  // results so no dangling tool message survives.
  const duplicateAcrossSteps: ContextMessage[] = [
    user('u1'),
    assistant(['call_a'], 'first'),
    tool('call_a', 'first result'),
    assistant(['call_a', 'call_b'], 'second'),
    tool('call_a', 'second result'),
    tool('call_b'),
    user('u2'),
  ];

  it('leaves duplicate ids and their results untouched on the normal path', () => {
    const projected = project(duplicateAcrossSteps, { dropOrphanResults: true });
    const assistants = projected.filter(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
    expect(assistants[0]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_a']);
    expect(assistants[1]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_a', 'call_b']);
    expect(projected.filter((message) => message.role === 'tool')).toHaveLength(3);
  });

  it('under the strict flag, drops later duplicate calls together with their results', () => {
    const anomalies: ProjectionAnomaly[] = [];
    const projected = project(duplicateAcrossSteps, {
      dedupeDuplicateToolCalls: true,
      dropOrphanResults: true,
      onAnomaly: (anomaly) => anomalies.push(anomaly),
    });
    const assistants = projected.filter(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
    expect(assistants[0]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_a']);
    expect(assistants[1]?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_b']);
    const toolMessages = projected.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call_a', 'call_b']);
    expect(textOf(toolMessages[0])).toBe('first result');
    expect(anomalies).toContainEqual({
      kind: 'duplicate_tool_call_dropped',
      toolCallId: 'call_a',
    });
    expect(anomalies).toContainEqual({
      kind: 'duplicate_tool_result_dropped',
      toolCallId: 'call_a',
    });
    expect(everyToolUseImmediatelyAnswered(projected)).toBe(true);
  });

  it('under the strict flag, drops a duplicate call id within one assistant message', () => {
    const projected = project(
      [
        user('u1'),
        assistant(['call_dup', 'call_dup'], 'calling twice'),
        tool('call_dup', 'result'),
        user('u2'),
      ],
      { dedupeDuplicateToolCalls: true, dropOrphanResults: true },
    );
    const assistantMessage = projected.find((message) => message.role === 'assistant');
    expect(assistantMessage?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['call_dup']);
    expect(everyToolUseImmediatelyAnswered(projected)).toBe(true);
  });

  it("under the strict flag, reattaches a later duplicate's result when the first call has none", () => {
    const projected = project(
      [
        user('u1'),
        assistant(['call_a'], 'first attempt'),
        assistant(['call_a'], 'second attempt'),
        tool('call_a', 'late result'),
        user('u2'),
      ],
      { dedupeDuplicateToolCalls: true, dropOrphanResults: true },
    );
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(textOf(projected[2])).toBe('late result');
    expect(everyToolUseImmediatelyAnswered(projected)).toBe(true);
  });

  it('under the strict flag, drops an assistant message left empty after removing duplicates', () => {
    const projected = project(
      [user('u1'), assistant(['call_a'], 'first'), tool('call_a'), assistant(['call_a']), user('u2')],
      { dedupeDuplicateToolCalls: true, dropOrphanResults: true },
    );
    expect(projected.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
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
