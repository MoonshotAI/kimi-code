import { describe, expect, it } from 'vitest';
import type { ChatTurn, ToolCall, TurnBlock } from '../../src/renderer/types';
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
  turnFinalText,
  turnHasOutput,
  turnToMarkdown,
  turnTocTitle,
  turnVisibleFinalText,
  turnWorkMs,
} from '@moonshot-ai/app-components/support';

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'read', arg: `· ${id}.ts`, status: 'ok', ...over };
}

function toolBlock(id: string, over: Partial<ToolCall> = {}): Extract<TurnBlock, { kind: 'tool' }> {
  return { kind: 'tool', tool: tool(id, over) };
}

function assistantTurn(blocks: TurnBlock[], over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', role: 'assistant', no: 1, text: '', blocks, ...over };
}

function ntfBlock(id: string, type = 'task.completed'): Extract<TurnBlock, { kind: 'notification' }> {
  return {
    kind: 'notification',
    notification: {
      id,
      type,
      sourceKind: 'background_task',
      sourceId: id,
      title: `task ${id}`,
      severity: 'info',
      body: 'done',
      raw: '{}',
    },
  };
}

describe('formatTokens', () => {
  it('keeps small counts verbatim and switches to k at 1024', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1024)).toBe('1k');
    expect(formatTokens(1500)).toBe('1.5k');
  });

  it('stays 1024-based through the k / M ranges', () => {
    expect(formatTokens(50_586)).toBe('49.4k');
    expect(formatTokens(102_400)).toBe('100k');
    expect(formatTokens(262_144)).toBe('256k');
    expect(formatTokens(999_999)).toBe('977k');
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
        toolBlock('c', { name: 'edit' }),
        toolBlock('d', { name: 'write' }),
        toolBlock('e', { name: 'grep' }),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('keeps subagent cards outside activity runs while folding bash', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([
        { kind: 'thinking', thinking: 'plan' },
        toolBlock('r1'),
        toolBlock('b1', { name: 'shell' }),
        toolBlock('r2'),
        toolBlock('a1', { name: 'Agent' }),
        toolBlock('g1', { name: 'grep' }),
        toolBlock('b2', { name: 'Bash' }),
        toolBlock('g2', { name: 'grep' }),
        toolBlock('a2', { name: 'Subagent' }),
      ]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'tool', 'activity-run', 'tool']);
    const foldedToolIds = rendered.flatMap((b) =>
      b.kind === 'activity-run' ? b.items.flatMap((item) => item.kind === 'tool' ? [item.tool.id] : []) : [],
    );
    expect(foldedToolIds).toEqual(['r1', 'b1', 'r2', 'g1', 'b2', 'g2']);
    const standaloneToolIds = rendered.flatMap((b) => b.kind === 'tool' ? [b.tool.id] : []);
    expect(standaloneToolIds).toEqual(['a1', 'a2']);
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

  it('folds interaction and progress card kinds too (todo, question, goals, swarm)', () => {
    for (const name of [
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

  it('keeps a browser screenshot inside the run as a working step', () => {
    const screenshot = toolBlock('c', { status: 'ok', name: 'mcp__desktop_browser__run', media: { kind: 'image', url: 'x' } });
    expect(rendersToolCard(screenshot)).toBe(true);
    const rendered = assistantRenderBlocks(assistantTurn([toolBlock('a'), screenshot, toolBlock('b')]));
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
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

  it('keeps a mid-run notification before later tools', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), toolBlock('b'), ntfBlock('n1'), toolBlock('c')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'notification', 'tool']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1]);
    }
    expect(rendered[1]).toMatchObject({ sourceIndex: 2 });
    expect(rendered[2]).toMatchObject({ sourceIndex: 3, tool: { id: 'c' } });
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
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'notification', 'tool']);
    expect(rendered[1]).toMatchObject({ items: [{ id: 'n1' }, { id: 'n2' }] });
  });

  it('preserves notification and tool order before the final text', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), ntfBlock('n1'), toolBlock('b'), { kind: 'text', text: 'done' }]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'notification', 'tool', 'text']);
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
    const turn = assistantTurn([
      {
        kind: 'text',
        text: 'compare [report.pdf](kimi-code-composer://attachments/1) with [src/](kimi-code-composer://attachments/2) and [m.ts](src/m.ts)',
      },
    ]);
    expect(turnToMarkdown(turn)).toBe('compare report.pdf with src/ and [m.ts](src/m.ts)');
  });

  it('serializes notification blocks so copies keep the visible context', () => {
    const turn = assistantTurn([
      { kind: 'text', text: 'restarting dev' },
      ntfBlock('n1'),
    ]);
    expect(turnToMarkdown(turn)).toBe(
      ['restarting dev', '> **Notification**\n> task n1\n> task.completed\n> done'].join('\n\n'),
    );
  });

  it('quotes EVERY line of a multi-line notification body', () => {
    const turn = assistantTurn([ntfBlock('n1')]);
    const block = turn.blocks?.[0];
    if (block?.kind === 'notification') block.notification = { ...block.notification, body: 'line one\nline two' };
    expect(turnToMarkdown(turn)).toBe(
      '> **Notification**\n> task n1\n> task.completed\n> line one\n> line two',
    );
  });

  it('escapes Markdown-active attachment names in the export (the bubble shows them literally)', () => {
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
        outputPreview: { text: 'line a\nline b', bytes: 100, truncated: true },
      };
    expect(turnToMarkdown(turn)).toBe(
      '> **Notification**\n> task n1\n> task.completed\n> done\n\n```\n[output-preview]\nline a\nline b\n```',
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

describe('notification render blocks', () => {
  it('merges consecutive notifications into ONE render block, in order', () => {
    const rendered = assistantRenderBlocks(assistantTurn([ntfBlock('a'), ntfBlock('b')]));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'notification', sourceIndex: 0 });
    if (rendered[0]?.kind === 'notification') {
      expect(rendered[0].items.map((n) => n.id)).toEqual(['a', 'b']);
    }
  });

  it('breaks notification grouping on any non-notification block', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([ntfBlock('a'), { kind: 'text', text: 'x' }, ntfBlock('b')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['notification', 'text', 'notification']);
    for (const b of rendered) {
      if (b.kind === 'notification') expect(b.items).toHaveLength(1);
    }
  });

  it('splits activity runs at a notification', () => {
    const rendered = assistantRenderBlocks(
      assistantTurn([toolBlock('a'), toolBlock('b'), ntfBlock('n'), toolBlock('c'), toolBlock('d')]),
    );
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run', 'notification', 'activity-run']);
    if (rendered[0]?.kind === 'activity-run') {
      expect(rendered[0].items.map((it) => it.sourceIndex)).toEqual([0, 1]);
    }
    if (rendered[2]?.kind === 'activity-run') {
      expect(rendered[2].items.map((it) => it.sourceIndex)).toEqual([3, 4]);
    }
  });

  it('keeps notifications separated by thinking or tools in distinct groups', () => {
    const rendered = assistantRenderBlocks(assistantTurn([
      toolBlock('a'),
      ntfBlock('n1'),
      { kind: 'thinking', thinking: 'continue' },
      toolBlock('b'),
      ntfBlock('n2'),
    ]));
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'notification', 'activity-run', 'notification']);
    expect(rendered[1]).toMatchObject({ items: [{ id: 'n1' }] });
    expect(rendered[3]).toMatchObject({ items: [{ id: 'n2' }] });
  });

  it('folds a notification into the fold with the surrounding work', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([toolBlock('a'), toolBlock('b'), ntfBlock('n'), { kind: 'text', text: 'final' }]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['activity-run', 'notification']);
    expect(visible.map((b) => b.kind)).toEqual(['text']);
  });

  it('keeps a notification visible in a no-text turn (the card is the turn output)', () => {
    const { folded, visible } = splitAssistantFold(
      assistantTurn([toolBlock('a'), ntfBlock('n')]),
    );
    expect(folded.map((b) => b.kind)).toEqual(['tool']);
    expect(visible.map((b) => b.kind)).toEqual(['notification']);
  });

  it('renders a notification-only turn without a fold row', () => {
    const { folded, visible } = splitAssistantFold(assistantTurn([ntfBlock('n')]));
    expect(folded).toEqual([]);
    expect(visible.map((b) => b.kind)).toEqual(['notification']);
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

  it('copies only the latest visible final answer across round boundaries', () => {
    const turn = assistantTurn([
      { kind: 'text', text: 'first final', final: true },
      { kind: 'text', text: 'latest final' },
    ]);
    expect(splitAssistantFold(turn).visible.map((block) => block.kind)).toEqual(['text', 'text']);
    expect(turnVisibleFinalText(turn)).toBe('latest final');
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

describe('turnHasOutput', () => {
  it('is false for a zero-output shell (a turn cancelled before its first part)', () => {
    expect(turnHasOutput(assistantTurn([]))).toBe(false);
    expect(turnHasOutput(assistantTurn([{ kind: 'text', text: '  ' }]))).toBe(false);
    expect(turnHasOutput(assistantTurn([{ kind: 'thinking', thinking: '' }]))).toBe(false);
  });

  it('is true for text, thinking, or tool output', () => {
    expect(turnHasOutput(assistantTurn([{ kind: 'text', text: 'hi' }]))).toBe(true);
    expect(turnHasOutput(assistantTurn([{ kind: 'thinking', thinking: 'hmm' }]))).toBe(true);
    expect(turnHasOutput(assistantTurn([toolBlock('t1')]))).toBe(true);
  });

  it('is true for a notification-only turn — the card is the turn output', () => {
    expect(turnHasOutput(assistantTurn([ntfBlock('n')]))).toBe(true);
  });
});

describe('flattenAssistantFold', () => {
  it('restores source order across the fold boundary', () => {
    const fold = splitAssistantFold(assistantTurn([
      toolBlock('a'),
      ntfBlock('n1'),
      toolBlock('b'),
      { kind: 'text', text: 'done' },
    ]));
    expect(fold.folded.map((b) => b.kind)).toEqual(['tool', 'notification', 'tool']);
    expect(fold.visible.map((b) => b.kind)).toEqual(['text']);
    const flat = flattenAssistantFold(fold);
    expect(flat.map((b) => b.kind)).toEqual(['tool', 'notification', 'tool', 'text']);
    expect(
      flat.map((b) => (b.kind === 'activity-run' ? (b.items[0]?.sourceIndex ?? -1) : b.sourceIndex)),
    ).toEqual([0, 1, 2, 3]);
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
