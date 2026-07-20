import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall, TurnBlock } from '../../src/renderer/types';
import {
  assistantRenderBlocks,
  formatDuration,
  formatTokens,
  rendersToolCard,
  renderBlockKey,
  turnBlocks,
  turnFinalText,
  turnToMarkdown,
} from '../../src/renderer/components/chatTurnRendering';

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', arg: `· ${id}.ts`, status: 'ok', ...over };
}

function toolBlock(id: string, over: Partial<ToolCall> = {}): Extract<TurnBlock, { kind: 'tool' }> {
  return { kind: 'tool', tool: tool(id, over) };
}

function assistantTurn(blocks: TurnBlock[], over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', role: 'assistant', no: 1, text: '', blocks, ...over };
}

describe('formatTokens', () => {
  // Units are 1024-based: context sizes are powers of two, so a 256k context
  // must render as "256k", never "262k" (see src/lib/formatTokens.ts).
  it('keeps small counts verbatim and switches to k at 1024', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1024)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
  });

  it('stays 1024-based through the k / M ranges', () => {
    // k range: one decimal under 100k, rounded above.
    expect(formatTokens(50_586)).toBe('49.4k');
    expect(formatTokens(102_400)).toBe('100k');
    expect(formatTokens(262_144)).toBe('256k');
    // Just under 1 MiB is still k.
    expect(formatTokens(999_999)).toBe('977k');
    // M range: one decimal, trailing ".0" dropped.
    expect(formatTokens(1_048_576)).toBe('1M');
    expect(formatTokens(1_572_864)).toBe('1.5M');
    expect(formatTokens(2_500_000)).toBe('2.4M');
  });
});

describe('formatDuration', () => {
  it('switches units at the 1s and 1m boundaries', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m0.0s');
    expect(formatDuration(90_500)).toBe('1m30.5s');
  });
});

describe('turnBlocks', () => {
  it('returns the ordered blocks as-is when present', () => {
    const blocks: TurnBlock[] = [{ kind: 'text', text: 'hi' }];
    expect(turnBlocks(assistantTurn(blocks))).toBe(blocks);
  });

  it('falls back to thinking -> text -> tools order when blocks are absent', () => {
    const turn: ChatTurn = {
      id: 't1',
      role: 'assistant',
      no: 1,
      text: 'answer',
      thinking: 'plan',
      tools: [tool('a')],
    };
    expect(turnBlocks(turn)).toEqual([
      { kind: 'thinking', thinking: 'plan' },
      { kind: 'text', text: 'answer' },
      { kind: 'tool', tool: tool('a') },
    ]);
  });
});

describe('rendersToolCard', () => {
  it('hides the card only for a successful tool that carries inline media', () => {
    expect(rendersToolCard(toolBlock('a'))).toBe(true);
    expect(rendersToolCard(toolBlock('r', { status: 'running' }))).toBe(true);
    expect(
      rendersToolCard(toolBlock('m', { status: 'ok', media: { kind: 'image', url: 'x' } })),
    ).toBe(false);
    // media but errored -> still rendered as a card
    expect(
      rendersToolCard(toolBlock('e', { status: 'error', media: { kind: 'image', url: 'x' } })),
    ).toBe(true);
  });
});

describe('assistantRenderBlocks', () => {
  it('folds consecutive calls of one kind into one activity run', () => {
    const rendered = assistantRenderBlocks(assistantTurn([toolBlock('a'), toolBlock('b')]));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'activity-run' });
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.kind)).toEqual(['tool', 'tool']);
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1]);
    }
  });

  it('renders a lone tool as a standalone tool, not a run', () => {
    const rendered = assistantRenderBlocks(assistantTurn([toolBlock('a')]));
    expect(rendered).toEqual([{ kind: 'tool', tool: tool('a'), sourceIndex: 0 }]);
  });

  it('folds mixed kinds into one run — runs need not be homogeneous', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        toolBlock('a'),
        toolBlock('b'),
        toolBlock('c', { name: 'bash' }),
        toolBlock('d', { name: 'bash' }),
        toolBlock('e', { name: 'grep' }),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('folds edits and writes (the summary sentence carries their count)', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('e1', { name: 'edit' }), toolBlock('e2', { name: 'edit' })]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
  });

  it('folds thinking segments together with adjacent tool calls', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([{ kind: 'thinking', thinking: 'plan' }, toolBlock('a'), toolBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.kind)).toEqual(['thinking', 'tool', 'tool']);
      expect(rendered[0].items[0]).toMatchObject({ thinking: 'plan', sourceIndex: 0 });
    }
  });

  it('keeps a lone thinking segment standalone', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([{ kind: 'thinking', thinking: 'plan' }, { kind: 'text', text: 'answer' }]),
    );
    expect(rendered).toEqual([
      { kind: 'thinking', thinking: 'plan', sourceIndex: 0 },
      { kind: 'text', text: 'answer', sourceIndex: 1 },
    ]);
  });

  it('never folds sub-agent delegations (identity cards stand alone)', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('s1', { name: 'task' }), toolBlock('s2', { name: 'task' })]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'tool']);
  });

  it('lets a non-foldable kind break a run on both sides', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        toolBlock('a'),
        toolBlock('b'),
        toolBlock('e', { name: 'task' }),
        toolBlock('c'),
        toolBlock('d'),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'tool', 'activity-run']);
  });

  it('keeps unrecognized kinds standalone', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('x1', { name: 'cronlist' }), toolBlock('x2', { name: 'cronlist' })]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'tool']);
  });

  it('breaks the run when a text block interrupts it', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), { kind: 'text', text: 'x' }, toolBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'text', 'tool']);
  });

  it('breaks the run when a media tool (no card) interrupts it', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        toolBlock('a'),
        toolBlock('b'),
        toolBlock('c', { status: 'ok', media: { kind: 'image', url: 'x' } }),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'tool']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1]);
    }
  });

  it('preserves thinking/text order with their source indexes', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        { kind: 'thinking', thinking: 'plan' },
        { kind: 'text', text: 'answer' },
      ]),
    );
    expect(rendered).toEqual([
      { kind: 'thinking', thinking: 'plan', sourceIndex: 0 },
      { kind: 'text', text: 'answer', sourceIndex: 1 },
    ]);
  });
});

describe('turnFinalText', () => {
  it('joins only the text blocks, dropping thinking and tools', () => {
    const turn = assistantTurn([
      { kind: 'thinking', thinking: 'plan' },
      { kind: 'text', text: 'first' },
      toolBlock('a'),
      { kind: 'text', text: 'second' },
    ]);
    expect(turnFinalText(turn)).toBe('first\n\nsecond');
  });
});

describe('turnToMarkdown', () => {
  it('renders thinking as a quote, text verbatim, and tool output as a fenced block', () => {
    const turn = assistantTurn([
      { kind: 'thinking', thinking: 'line1\nline2' },
      { kind: 'text', text: 'hello' },
      toolBlock('a', { name: 'bash', output: ['out1', 'out2'] }),
    ]);
    expect(turnToMarkdown(turn)).toBe(
      ['> **Thinking**\n> line1\n> line2', 'hello', '```\n[bash]\nout1\nout2\n```'].join('\n\n'),
    );
  });
});

describe('renderBlockKey', () => {
  it('derives stable keys per block kind', () => {
    expect(renderBlockKey({ kind: 'text', text: 'x', sourceIndex: 2 }, 0)).toBe('text-2');
    expect(renderBlockKey({ kind: 'tool', tool: tool('a'), sourceIndex: 3 }, 0)).toBe('a');
    expect(
      renderBlockKey(
        { kind: 'activity-run', items: [{ kind: 'tool', tool: tool('a'), sourceIndex: 5 }] },
        0,
      ),
    ).toBe('activity-run-5');
  });
});
