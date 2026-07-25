/**
 * StateTree rendering tests (SSR via renderToStaticMarkup — no DOM needed).
 * Locks in two audit-panel readability rules:
 *  1. Unchanged subtrees collapse into `{ …N }` rows — never a one-line
 *     compact-JSON dump (the copy-on-write fast path gives them no diff
 *     children, and rendering the raw value destroyed the layout).
 *  2. Whole-subtree adds expand into fully fielded, indented tree rows.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_AGENT_STATE, type AgentState, type TranscriptTurn } from '@moonshot-ai/transcript';

import { diffValue } from '../../audit/diff';
import { serializeState } from '../../audit/serialize';
import { plainNode, StateTree } from './StateTree';

function turn(n: number, prompt: string): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: `t${n}`,
    ordinal: n,
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    steps: [],
  };
}

function stateWith(items: readonly TranscriptTurn[]): AgentState {
  return { ...EMPTY_AGENT_STATE, items };
}

describe('StateTree', () => {
  it('collapses unchanged subtrees instead of dumping compact JSON', () => {
    const t0 = turn(0, 'PROMPT_ZERO');
    const prev = stateWith([t0, turn(1, 'PROMPT_ONE')]);
    const next: AgentState = { ...prev, items: [t0, turn(1, 'PROMPT_ONE_V2')] };
    const html = renderToStaticMarkup(
      <StateTree root={diffValue(serializeState(prev), serializeState(next))} />,
    );
    // No one-line JSON blob anywhere.
    expect(html).not.toContain('{"kind"');
    // The unchanged turn t0 stays folded: its prompt is not rendered…
    expect(html).not.toContain('PROMPT_ZERO');
    // …while the modified turn opens and shows old → new.
    expect(html).toContain('PROMPT_ONE_V2');
    expect(html).toContain('PROMPT_ONE');
    expect(html).toContain('→');
  });

  it('expands whole-subtree adds into full field rows (all keys, no JSON dump)', () => {
    const root = diffValue(serializeState(EMPTY_AGENT_STATE), serializeState(stateWith([turn(0, 'HELLO')])));
    const html = renderToStaticMarkup(<StateTree root={root} />);
    expect(html).not.toContain('{"kind"');
    for (const field of ['turnId', 'ordinal', 'state', 'origin', 'prompt', 'steps']) {
      expect(html).toContain(field);
    }
    expect(html).toContain('HELLO');
  });

  it('expands added subtrees with id-based keys and renders closing braces', () => {
    const withSteps: TranscriptTurn = {
      ...turn(0, 'Q'),
      steps: [
        {
          kind: 'step',
          stepId: 't0.1',
          turnId: 't0',
          ordinal: 1,
          state: 'running',
          frames: [{ kind: 'thinking', frameId: 't0.1.f1', text: 'hmm' }],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <StateTree
        root={diffValue(serializeState(EMPTY_AGENT_STATE), serializeState(stateWith([withSteps])))}
      />,
    );
    // Array children are keyed by their ids, not #indices.
    expect(html).toContain('t0.1');
    expect(html).toContain('t0.1.f1');
    expect(html).not.toContain('#0');
    // Open containers end with an explicit closing brace row.
    expect(html).toContain(']');
    expect(html).toContain('}');
  });

  it('plain state mode opens to defaultDepth and shows all top-level fields', () => {
    const html = renderToStaticMarkup(
      <StateTree root={plainNode(serializeState(stateWith([turn(0, 'X')])))} defaultDepth={2} />,
    );
    for (const field of ['items', 'tasks', 'interactions', 'todos', 'meta', 'hasMoreOlder']) {
      expect(html).toContain(field);
    }
    expect(html).not.toContain('{"kind"');
  });
});
