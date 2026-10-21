import { EMPTY_AGENT_STATE, type AgentState, type TranscriptTurn } from '@moonshot-ai/transcript';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
    expect(html).not.toContain('{"kind"');
    expect(html).not.toContain('PROMPT_ZERO');
    expect(html).toContain('PROMPT_ONE_V2');
    expect(html).toContain('PROMPT_ONE');
    expect(html).toContain('→');
  });

  it('expands whole-subtree adds into full field rows (all keys, no JSON dump)', () => {
    const root = diffValue(
      serializeState(EMPTY_AGENT_STATE),
      serializeState(stateWith([turn(0, 'HELLO')])),
    );
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
    expect(html).toContain('t0.1');
    expect(html).toContain('t0.1.f1');
    expect(html).not.toContain('#0');
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

  it('collapses multiline strings into a hover-preview button', () => {
    const root = plainNode({ note: 'line one\nline two\nline three', single: 'one-liner' });
    const html = renderToStaticMarkup(<StateTree root={root} defaultDepth={1} />);
    expect(html).toContain('&quot;line one&quot; ⏎ 3');
    expect(html).not.toContain('line two');
    expect(html).not.toContain('line three');
    expect(html).toContain('&quot;one-liner&quot;');
  });
});
