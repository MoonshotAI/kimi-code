/**
 * StateTree rendering tests (SSR via renderToStaticMarkup — no DOM needed).
 * Locks in two audit-panel readability rules:
 *  1. Unchanged subtrees collapse into `{ …N }` rows — never a one-line
 *     compact-JSON dump (the copy-on-write fast path gives them no diff
 *     children, and rendering the raw value destroyed the layout).
 *  2. Whole-subtree adds expand into fully fielded, indented tree rows.
 */

import type { AssistantMessage, StepMessage, TurnMessage } from '@moonshot-ai/kap-server/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { diffValue } from '../../audit/diff';
import { serializeState } from '../../audit/serialize';
import { EMPTY_CHAT_STATE, type ChatState } from '../../transcript/store';
import { plainNode, StateTree } from './StateTree';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let tick = 0;

function ts(): string {
  tick += 1;
  return new Date(T0 + tick * 1000).toISOString();
}

function turnMsg(n: number, text?: string): TurnMessage {
  return {
    type: 'turn',
    session_id: 's1',
    agent_id: 'main',
    timestamp: ts(),
    turn_id: `t${n}`,
    ordinal: n,
    state: 'completed',
    origin: { kind: 'user' },
    user_message_id: text,
  };
}

function stepMsg(stepId: string): StepMessage {
  return {
    type: 'step',
    session_id: 's1',
    agent_id: 'main',
    timestamp: ts(),
    step_id: stepId,
    turn_id: stepId.split('.')[0] ?? 't0',
    ordinal: Number(stepId.split('.')[1] ?? '1'),
    state: 'running',
  };
}

function assistantMsg(stepId: string, text: string): AssistantMessage {
  return {
    type: 'assistant',
    session_id: 's1',
    agent_id: 'main',
    timestamp: ts(),
    message_id: `${stepId}.a0`,
    turn_id: stepId.split('.')[0] ?? 't0',
    step_id: stepId,
    status: 'streaming',
    text,
  };
}

type FlatMessage = TurnMessage | StepMessage | AssistantMessage;

function stateWithTimeline(items: readonly FlatMessage[]): ChatState {
  return {
    ...EMPTY_CHAT_STATE,
    entries: items.map((message) => ({
      key:
        message.type === 'turn'
          ? `turn:${message.turn_id}`
          : message.type === 'step'
            ? `step:${message.step_id}`
            : `assistant:${message.message_id}`,
      message,
    })),
  };
}

describe('StateTree', () => {
  it('collapses unchanged subtrees instead of dumping compact JSON', () => {
    const t0 = turnMsg(0, 'PROMPT_ZERO');
    const prev = stateWithTimeline([t0, turnMsg(1, 'PROMPT_ONE')]);
    const next: ChatState = stateWithTimeline([t0, turnMsg(1, 'PROMPT_ONE_V2')]);
    const html = renderToStaticMarkup(
      <StateTree root={diffValue(serializeState(prev), serializeState(next))} />,
    );
    // No one-line JSON blob anywhere.
    expect(html).not.toContain('{"type"');
    // The unchanged turn t0 stays folded: its marker is not rendered…
    expect(html).not.toContain('PROMPT_ZERO');
    // …while the modified turn opens and shows old → new.
    expect(html).toContain('PROMPT_ONE_V2');
    expect(html).toContain('PROMPT_ONE');
    expect(html).toContain('→');
  });

  it('expands whole-subtree adds into full field rows (all keys, no JSON dump)', () => {
    const root = diffValue(
      serializeState(EMPTY_CHAT_STATE),
      serializeState(stateWithTimeline([turnMsg(0, 'HELLO')])),
    );
    const html = renderToStaticMarkup(<StateTree root={root} />);
    expect(html).not.toContain('{"type"');
    for (const field of ['turn_id', 'ordinal', 'state', 'origin', 'timestamp', 'agent_id']) {
      expect(html).toContain(field);
    }
    expect(html).toContain('HELLO');
  });

  it('expands added subtrees with id-based keys and renders closing braces', () => {
    const html = renderToStaticMarkup(
      <StateTree
        root={diffValue(
          serializeState(EMPTY_CHAT_STATE),
          serializeState(
            stateWithTimeline([turnMsg(0), stepMsg('t0.1'), assistantMsg('t0.1', 'hmm')]),
          ),
        )}
      />,
    );
    // Array children are keyed by their ids, not #indices.
    expect(html).toContain('t0.1');
    expect(html).toContain('t0.1.a0');
    expect(html).not.toContain('#0');
    // Open containers end with an explicit closing brace row.
    expect(html).toContain(']');
    expect(html).toContain('}');
  });

  it('plain state mode opens to defaultDepth and shows all top-level fields', () => {
    const html = renderToStaticMarkup(
      <StateTree
        root={plainNode(serializeState(stateWithTimeline([turnMsg(0)])))}
        defaultDepth={2}
      />,
    );
    for (const field of ['timeline', 'interactions', 'tasks', 'todos', 'hasMoreOlder']) {
      expect(html).toContain(field);
    }
    expect(html).not.toContain('{"type"');
  });

  it('collapses multiline strings into a hover-preview button', () => {
    const root = plainNode({ note: 'line one\nline two\nline three', single: 'one-liner' });
    const html = renderToStaticMarkup(<StateTree root={root} defaultDepth={1} />);
    // The multiline value renders as a compact button: first-line preview +
    // line count, with the remaining lines NOT inlined into the tree (they
    // only appear in the hover panel, which needs a real mouse to open).
    expect(html).toContain('&quot;line one&quot; ⏎ 3');
    expect(html).not.toContain('line two');
    expect(html).not.toContain('line three');
    // Single-line strings keep the inline rendering.
    expect(html).toContain('&quot;one-liner&quot;');
  });
});
