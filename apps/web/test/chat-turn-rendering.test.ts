import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall, TurnBlock } from '../src/types';
import {
  assistantRenderBlocks,
  formatDuration,
  formatTokens,
  rendersToolCard,
  renderBlockKey,
  flattenAssistantFold,
  splitAssistantFold,
  turnActivitySeedMs,
  turnBlocks,
  turnFileChanges,
  turnFinalText,
  turnToMarkdown,
  turnTocTitle,
  turnVisibleFinalText,
  turnWorkMs,
} from '../src/components/chatTurnRendering';

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', arg: `· ${id}.ts`, status: 'ok', ...over };
}

function toolBlock(id: string, over: Partial<ToolCall> = {}): Extract<TurnBlock, { kind: 'tool' }> {
  return { kind: 'tool', tool: tool(id, over) };
}

function ntfBlock(id: string, type = 'task.completed'): Extract<TurnBlock, { kind: 'notification' }> {
  return {
    kind: 'notification',
    notification: {
      id,
      category: 'task',
      type,
      sourceKind: 'background_task',
      sourceId: id,
      title: 'task',
      body: `task ${id}`,
      raw: `<notification id="${id}"></notification>`,
    },
  };
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
  it('floors to whole seconds, hides sub-second spans, and drops trailing zero units', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(999)).toBe('');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(14_000)).toBe('14s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(90_500)).toBe('1m30s');
    expect(formatDuration(297_000)).toBe('4m57s');
    expect(formatDuration(359_676)).toBe('5m59s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_899_999)).toBe('1h4m');
    expect(formatDuration(3_900_000)).toBe('1h5m');
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

  it('folds unrecognized kinds (skills, MCP tools) into the run', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        toolBlock('a'),
        toolBlock('s', { name: 'Skill' }),
        toolBlock('m', { name: 'mcp__github__create_issue' }),
        toolBlock('b'),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1, 2, 3]);
    }
  });

  it('folds interaction and progress card kinds too (task, todo, question, goals, swarm)', () => {
    for (const name of [
      'task',
      'todo',
      'agentswarm',
      'askuserquestion',
      'creategoal',
      'getgoal',
      'setgoalbudget',
      'updategoal',
    ]) {
      const rendered = assistantRenderBlocks(
        assistantTurn([toolBlock('x1', { name }), toolBlock('x2', { name })]),
      );
      expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
    }
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

  it('defers a mid-run notification until after the run — it never breaks the group', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), toolBlock('b'), ntfBlock('n1'), toolBlock('c')]),
    );
    // The three calls stay in ONE fold group; the notification follows it.
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'notification']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1, 3]);
    }
    expect(rendered[1]).toMatchObject({ sourceIndex: 2 });
  });

  it('renders a notification in place when no run is open', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([ntfBlock('n1'), toolBlock('a'), toolBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['notification', 'activity-run']);
  });

  it('still merges consecutive notifications into one render block', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), ntfBlock('n1'), ntfBlock('n2'), toolBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'notification']);
    expect(rendered[1]).toMatchObject({ items: [{ id: 'n1' }, { id: 'n2' }] });
  });

  it('text still closes the run, with a deferred notification between run and text', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), ntfBlock('n1'), toolBlock('b'), { kind: 'text', text: 'done' }]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'notification', 'text']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 2]);
    }
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

  it('strips composer-private attachment links from text blocks (pill-flow user messages)', () => {
    // The bubble keeps `kimi-code-composer://attachments/<index>` links for
    // its inline pills, but the Markdown export is a plain-text surface —
    // the private scheme must not leak; the pill degrades to its bare name
    // (a folder's keeps its trailing '/'). Mention links are untouched.
    const turn = assistantTurn([
      {
        kind: 'text',
        text: 'compare [report.pdf](kimi-code-composer://attachments/1) with [src/](kimi-code-composer://attachments/2) and [m.ts](src/m.ts)',
      },
    ]);
    expect(turnToMarkdown(turn)).toBe('compare report.pdf with src/ and [m.ts](src/m.ts)');
  });

  it('escapes Markdown-active attachment names in the export (the bubble shows them literally)', () => {
    // `# notes.md` would re-parse as a heading, `---` as a thematic break,
    // `*em*` as emphasis; ordinary names pass through clean.
    const turn = assistantTurn([
      {
        kind: 'text',
        text: 'read [# notes.md](kimi-code-composer://attachments/1), [---](kimi-code-composer://attachments/2), [*em*](kimi-code-composer://attachments/3), [report.pdf](kimi-code-composer://attachments/4)',
      },
    ]);
    expect(turnToMarkdown(turn)).toBe('read \\# notes.md, \\---, \\*em\\*, report.pdf');
  });

  it('keeps the notification output preview in the copy as a fenced block', () => {
    const turn = assistantTurn([ntfBlock('n1')]);
    const block = turn.blocks?.[0];
    if (block?.kind === 'notification')
      block.notification = {
        ...block.notification,
        outputPreview: { text: 'line a\nline b', bytes: 13, totalBytes: 100, truncated: true },
      };
    expect(turnToMarkdown(turn)).toBe(
      '> **Notification**\n> task\n> task.completed\n> task n1\n\n```\n[output-preview]\nline a\nline b\n```',
    );
  });

  it('serializes a preview-only notification — the preview is its whole visible result', () => {
    const turn = assistantTurn([ntfBlock('n1')]);
    const block = turn.blocks?.[0];
    if (block?.kind === 'notification')
      block.notification = {
        ...block.notification,
        title: '',
        body: '',
        outputPreview: { text: 'tail of the task output' },
      };
    expect(turnToMarkdown(turn)).toBe(
      '> **Notification**\n> task.completed\n\n```\n[output-preview]\ntail of the task output\n```',
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

describe('splitAssistantFold', () => {
  it('folds nothing when the turn is a lone text block', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([{ kind: 'text', text: 'answer' }]),
    );
    expect(folded).toEqual([]);
    expect(visible.map((b) => b.kind)).toEqual(['text']);
  });

  it('folds everything before the final text block', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([
        { kind: 'thinking', thinking: 'plan' },
        { kind: 'text', text: 'interim' },
        toolBlock('a'),
        toolBlock('b'),
        { kind: 'text', text: 'final' },
      ]),
    );
    // thinking+interim text stand alone; a+b fold into one activity-run.
    expect(folded.map((b) => b.kind)).toEqual(['thinking', 'text', 'activity-run']);
    expect(visible.map((b) => b.kind)).toEqual(['text']);
    expect(visible[0]).toMatchObject({ text: 'final' });
  });

  it('keeps trailing blocks after the final text visible (media/cards stay on screen)', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([
        toolBlock('a'),
        toolBlock('b'),
        { kind: 'text', text: 'final' },
        toolBlock('m', { status: 'ok', media: { kind: 'image', url: 'x' } }),
      ]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['activity-run']);
    expect(visible.map((b) => b.kind)).toEqual(['text', 'tool']);
  });

  it('folds the whole turn when it has no text block (e.g. interrupted)', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([{ kind: 'thinking', thinking: 'plan' }, toolBlock('a'), toolBlock('b')]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['activity-run']);
    expect(visible).toEqual([]);
  });

  it('keeps a media-only final output visible (inline media is the turn output)', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([
        toolBlock('a'),
        toolBlock('m', { status: 'ok', media: { kind: 'image', url: 'x' } }),
      ]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['tool']);
    expect(visible.map((b) => b.kind)).toEqual(['tool']);
    expect(visible[0]).toMatchObject({ tool: { id: 'm' } });
  });

  it('keeps every media output visible when a no-text turn produces several', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([
        { kind: 'thinking', thinking: 'plan' },
        toolBlock('m1', { status: 'ok', media: { kind: 'image', url: 'x' } }),
        toolBlock('m2', { status: 'ok', media: { kind: 'image', url: 'y' } }),
      ]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['thinking']);
    expect(visible.map((b) => b.kind)).toEqual(['tool', 'tool']);
    expect(visible[0]).toMatchObject({ tool: { id: 'm1' } });
    expect(visible[1]).toMatchObject({ tool: { id: 'm2' } });
  });

  it('still folds wholesale when a no-text turn ends with a failed media tool', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([toolBlock('e', { status: 'error', media: { kind: 'image', url: 'x' } })]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['tool']);
    expect(visible).toEqual([]);
  });

  it('ignores empty text blocks when locating the final text', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([
        { kind: 'text', text: 'final' },
        { kind: 'text', text: '   ' },
      ]),
    );
    expect(folded).toEqual([]);
    expect(visible.map((b) => b.kind)).toEqual(['text', 'text']);
  });

  it('returns an empty split for an empty turn', () => {
    const { folded, visible } = splitAssistantFold(assistantTurn([]));
    expect(folded).toEqual([]);
    expect(visible).toEqual([]);
  });
});

describe('turnActivitySeedMs', () => {
  it('returns the earliest thinking start across the turn', () => {
    const blocks: TurnBlock[] = [
      { kind: 'text', text: 'x' },
      { kind: 'thinking', thinking: 'b', startedAt: '2026-07-20T10:00:10.000Z' },
      { kind: 'thinking', thinking: 'a', startedAt: '2026-07-20T10:00:05.000Z' },
    ];
    expect(turnActivitySeedMs(blocks)).toBe(Date.parse('2026-07-20T10:00:05.000Z'));
  });

  it('is undefined without timed thinking blocks (history turns)', () => {
    expect(turnActivitySeedMs([{ kind: 'text', text: 'x' }])).toBeUndefined();
    expect(turnActivitySeedMs([{ kind: 'thinking', thinking: 'plan' }])).toBeUndefined();
  });

  it('skips unparseable stamps', () => {
    const blocks: TurnBlock[] = [
      { kind: 'thinking', thinking: 'bad', startedAt: 'not-a-date' },
      { kind: 'thinking', thinking: 'ok', startedAt: '2026-07-20T10:00:05.000Z' },
    ];
    expect(turnActivitySeedMs(blocks)).toBe(Date.parse('2026-07-20T10:00:05.000Z'));
  });
});

describe('turnVisibleFinalText', () => {
  it('returns the only text of a text-only turn', () => {
    expect(turnVisibleFinalText(assistantTurn([{ kind: 'text', text: 'answer' }]))).toBe('answer');
  });

  it('drops the interim texts folded before the final text block', () => {
    const turn = assistantTurn([
      { kind: 'text', text: 'interim' },
      toolBlock('a'),
      { kind: 'text', text: 'final' },
    ]);
    expect(turnVisibleFinalText(turn)).toBe('final');
  });

  it('is empty when the turn has no text block', () => {
    expect(
      turnVisibleFinalText(assistantTurn([{ kind: 'thinking', thinking: 'plan' }, toolBlock('a')])),
    ).toBe('');
  });

  it('ignores trailing non-text blocks after the final text', () => {
    const turn = assistantTurn([
      { kind: 'text', text: 'final' },
      toolBlock('m', { status: 'ok', media: { kind: 'image', url: 'x' } }),
    ]);
    expect(turnVisibleFinalText(turn)).toBe('final');
  });
});

describe('turnWorkMs', () => {
  const T0 = Date.parse('2026-07-20T10:00:00.000Z');

  it('is undefined without a stamped start while live', () => {
    expect(turnWorkMs({ state: { phase: 'live', nowMs: T0 + 5000 } })).toBeUndefined();
  });

  it('ticks end-to-end from the stamped start while live', () => {
    expect(turnWorkMs({ startMs: T0, state: { phase: 'live', nowMs: T0 + 37_000 } })).toBe(37_000);
  });

  it('prefers the daemon duration once settled', () => {
    expect(
      turnWorkMs({
        startMs: T0,
        endedMs: T0 + 99_000,
        durationMs: 42_000,
        state: { phase: 'settled' },
      }),
    ).toBe(42_000);
  });

  it('falls back to the server message stamps once settled (history)', () => {
    expect(turnWorkMs({ startMs: T0, endedMs: T0 + 65_000, state: { phase: 'settled' } })).toBe(
      65_000,
    );
  });

  it('is undefined once settled without any stamps', () => {
    expect(turnWorkMs({ state: { phase: 'settled' } })).toBeUndefined();
    expect(turnWorkMs({ startMs: T0, state: { phase: 'settled' } })).toBeUndefined();
  });

  it('never goes negative', () => {
    expect(turnWorkMs({ startMs: T0 + 5000, endedMs: T0, state: { phase: 'settled' } })).toBe(0);
    expect(turnWorkMs({ startMs: T0, state: { phase: 'live', nowMs: T0 - 1000 } })).toBe(0);
  });
});

describe('turnFileChanges', () => {
  const editArg = (path: string, oldS: string, newS: string) =>
    JSON.stringify({ path, old_string: oldS, new_string: newS });

  it('is empty for a turn without file-touching tools', () => {
    expect(turnFileChanges(assistantTurn([toolBlock('t1')]))).toEqual([]);
    expect(turnFileChanges(assistantTurn([{ kind: 'text', text: 'done' }]))).toEqual([]);
  });

  it('counts a single edit’s added/removed lines', () => {
    const turn = assistantTurn([toolBlock('t1', { name: 'Edit', arg: editArg('a.ts', 'x\ny', 'x\nz\nw') })]);
    expect(turnFileChanges(turn)).toEqual([
      { path: 'a.ts', added: 2, removed: 1, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('merges repeated edits to the same file, keeping first-mention order', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('b.ts', 'a', 'a\nb') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('a.ts', 'q', 'q') }),
      toolBlock('t3', { name: 'multi_edit', arg: JSON.stringify({ path: 'b.ts', edits: [{ old_string: 'c', new_string: 'd\ne' }] }) }),
    ]);
    expect(turnFileChanges(turn)).toEqual([
      { path: 'b.ts', added: 3, removed: 1, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
      { path: 'a.ts', added: 0, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('merges equivalent spellings of one file into a single entry', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('src/a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('./src/a.ts', 'p', 'p\nq') }),
      toolBlock('t3', { name: 'Edit', arg: editArg('src//a.ts', 'm', 'm\nn') }),
    ]);
    // One entry (first-seen spelling kept), counts summed across all three.
    expect(turnFileChanges(turn)).toEqual([
      { path: 'src/a.ts', added: 3, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('keeps an unresolvable leading ".." so distinct files do not merge', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('../shared/a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('shared/a.ts', 'p', 'p\nq') }),
    ]);
    // "../shared/a.ts" and "shared/a.ts" are different files — two entries.
    expect(turnFileChanges(turn)).toEqual([
      { path: '../shared/a.ts', added: 1, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
      { path: 'shared/a.ts', added: 1, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('keeps a POSIX absolute path distinct from its rootless twin', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('/tmp/a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('tmp/a.ts', 'p', 'p\nq') }),
    ]);
    // "/tmp/a.ts" ≠ "tmp/a.ts" — the absolute root is an anchor, so two entries.
    expect(turnFileChanges(turn)).toEqual([
      { path: '/tmp/a.ts', added: 1, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
      { path: 'tmp/a.ts', added: 1, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('folds case for Windows paths but not POSIX', () => {
    const win = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('C:\\Repo\\a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('c:\\repo\\A.ts', 'p', 'p\nq') }),
    ]);
    // Windows paths are case-insensitive — one entry (first-seen spelling kept).
    expect(turnFileChanges(win).length).toBe(1);
    const posix = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('/Repo/a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('/repo/A.ts', 'p', 'p\nq') }),
    ]);
    // POSIX stays case-sensitive — two distinct files.
    expect(turnFileChanges(posix).length).toBe(2);
  });

  it('keeps a UNC share root as an unpoppable anchor', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('\\\\server\\share\\a.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('\\\\server\\share\\sub\\..\\a.ts', 'p', 'p\nq') }),
    ]);
    // Both spell the same file on the share — one entry.
    expect(turnFileChanges(turn).length).toBe(1);
  });

  it('does not merge a UNC child path with the share root', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('\\\\server\\share\\dir\\file.ts', 'x', 'x\ny') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('\\\\server\\sharedir\\file.ts', 'p', 'p\nq') }),
    ]);
    // "//server/share/dir/file.ts" ≠ "//server/sharedir/file.ts" — two entries,
    // not one merged by a missing separator.
    expect(turnFileChanges(turn).length).toBe(2);
  });

  it('treats a write as incomplete — new file vs overwrite is unknowable', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Write', arg: JSON.stringify({ path: 'n.ts', content: 'l1\nl2\nl3\n' }) }),
    ]);
    expect(turnFileChanges(turn)).toEqual([
      { path: 'n.ts', added: 0, removed: 0, hasWrite: true, statsIncomplete: true, diff: null },
    ]);
  });

  it('flags edits whose stats cannot be derived (replace_all, bad arg)', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: JSON.stringify({ path: 'r.ts', old_string: 'a', new_string: 'b', replace_all: true }) }),
      toolBlock('t2', { name: 'Edit', arg: 'not json' }),
      toolBlock('t3', { name: 'Write', arg: JSON.stringify({ path: 'w.ts' }) }),
    ]);
    expect(turnFileChanges(turn)).toEqual([
      { path: 'r.ts', added: 0, removed: 0, hasWrite: false, statsIncomplete: true, diff: null },
      { path: 'w.ts', added: 0, removed: 0, hasWrite: true, statsIncomplete: true, diff: null },
    ]);
  });

  it('skips errored calls — their diff describes an attempt, not a change', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('a.ts', 'x', 'y'), status: 'error' }),
    ]);
    expect(turnFileChanges(turn)).toEqual([]);
  });

  it('reads tools from the aggregate field when blocks are absent', () => {
    const turn = assistantTurn([], {
      blocks: undefined,
      tools: [tool('t1', { name: 'Edit', arg: editArg('f.ts', 'one', 'one\ntwo') })],
    });
    expect(turnFileChanges(turn)).toEqual([
      { path: 'f.ts', added: 1, removed: 0, hasWrite: false, statsIncomplete: false, diff: expect.any(Array) },
    ]);
  });

  it('carries the per-file line diff alongside the stats', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('g.ts', 'alpha\nbeta', 'alpha\ngamma') }),
    ]);
    const change = turnFileChanges(turn)[0]!;
    expect(change.diff).not.toBeNull();
    // The diff shows the removed and the added line for the one edited line.
    const texts = change.diff!.map((l) => `${l.type}:${l.text}`);
    expect(texts).toContain('del:beta');
    expect(texts).toContain('add:gamma');
  });

  it('joins a repeated edit’s diff with a hunk separator', () => {
    const turn = assistantTurn([
      toolBlock('t1', { name: 'Edit', arg: editArg('h.ts', 'a', 'a\nb') }),
      toolBlock('t2', { name: 'Edit', arg: editArg('h.ts', 'c', 'c\nd') }),
    ]);
    const change = turnFileChanges(turn)[0]!;
    expect(change.diff!.some((l) => l.type === 'hunk')).toBe(true);
  });
});

describe('flattenAssistantFold', () => {
  it('restores source order for notifications punched out of the folded prefix', () => {
    // A notification INSIDE a tool run defers to just after the run block and
    // is then punched out of the folded prefix into the visible tail — a
    // plain concat would move it after the run's whole group.
    const fold = splitAssistantFold(assistantTurn([
      toolBlock('a'),
      ntfBlock('n1'),
      toolBlock('b'),
      { kind: 'text', text: 'done' },
    ]));
    expect(fold.folded.map((b) => b.kind)).toEqual(['activity-run']);
    expect(fold.visible[0]?.kind).toBe('notification');
    const flat = flattenAssistantFold(fold);
    expect(flat.map((b) => b.kind)).toEqual(['activity-run', 'notification', 'text']);
    expect(
      flat.map((b) => (b.kind === 'activity-run' ? (b.items[0]?.sourceIndex ?? -1) : b.sourceIndex)),
    ).toEqual([0, 1, 3]);
  });
});

describe('turnTocTitle', () => {
  const t = (key: string) => key;
  const userTurn = (text: string): ChatTurn => ({ id: 'u1', role: 'user', no: 1, text });

  it('degrades attachment pills to bare names in the rail title', () => {
    expect(
      turnTocTitle(
        userTurn('fix [report.pdf](kimi-code-composer://attachments/1) and [src/](kimi-code-composer://attachments/2) now'),
        t,
      ),
    ).toBe('fix report.pdf and src/ now');
  });

  it('keeps mention links untouched', () => {
    expect(turnTocTitle(userTurn('see [a.ts](src/a.ts) please'), t)).toBe('see [a.ts](src/a.ts) please');
  });

  it('collapses whitespace, falls back for an empty user text, and labels compaction', () => {
    expect(turnTocTitle(userTurn('  multi\n line   text  '), t)).toBe('multi line text');
    expect(turnTocTitle(userTurn(''), t)).toBe('user');
    expect(turnTocTitle({ id: 'c1', role: 'compaction', no: 2, text: 'summary' }, t)).toBe('conversation.compactedPlain');
  });
});
