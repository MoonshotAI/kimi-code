import { describe, expect, it } from 'vitest';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';

import {
  activityRunTailIndex,
  assistantRenderBlocks,
  canCopyUserTurn,
  estimateUserTurnHeight,
  latestNotifyToolCallId,
  latestSettledDaemonTurnIds,
  splitAssistantFold,
  streamingTailIndex,
  turnBlocks,
  turnToMarkdown,
  userTurnDisplayText,
} from '../src/chatTurnRendering';

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: 'u1',
    role: 'user',
    no: 1,
    text: '',
    ...over,
  } as ChatTurn;
}

describe('userTurnDisplayText', () => {
  it('shows the synthesized pill + args for a bundled activation with empty user text', () => {
    const t = turn({ skillActivations: [{ name: 'deploy', args: 'to prod' }] });
    expect(userTurnDisplayText(t)).toBe('[deploy](kimi-code://skill/deploy) to prod');
    expect(canCopyUserTurn(t)).toBe(true);
  });

  it('hides copy only when the projected user text is empty', () => {
    expect(canCopyUserTurn(turn())).toBe(false);
    expect(canCopyUserTurn(turn({ text: '  ' }))).toBe(false);
  });

  it('keeps the raw text for plain and single-skill turns', () => {
    expect(userTurnDisplayText(turn({ text: 'plain' }))).toBe('plain');
    expect(
      userTurnDisplayText(turn({ text: 'to prod', skillActivation: { name: 'deploy', args: 'to prod' } })),
    ).toBe('to prod');
  });

  it('leaves already-visible args of an in-text pill untouched', () => {
    const t = turn({
      text: 'ship [deploy](kimi-code://skill/deploy) carefully',
      skillActivations: [{ name: 'deploy' }],
    });
    expect(userTurnDisplayText(t)).toBe('ship [deploy](kimi-code://skill/deploy) carefully');
  });
});

describe('turnBlocks / turnToMarkdown for bundled user turns', () => {
  it('emits the display text block even when turn.text is empty', () => {
    const t = turn({ skillActivations: [{ name: 'deploy' }, { name: 'review' }] });
    expect(turnBlocks(t)).toEqual([
      {
        kind: 'text',
        text: '[deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review)',
      },
    ]);
    expect(turnToMarkdown(t)).toBe('[deploy](kimi-code://skill/deploy) [review](kimi-code://skill/review)');
  });

  it('copies the visible args that the bubble shows next to the pill', () => {
    const t = turn({
      text: 'ship it [deploy](kimi-code://skill/deploy)',
      skillActivations: [{ name: 'deploy', args: 'to prod' }],
    });
    expect(turnToMarkdown(t)).toBe('ship it [deploy](kimi-code://skill/deploy) to prod');
  });

  it('keeps the plain user turn unchanged', () => {
    expect(turnToMarkdown(turn({ text: 'hello there' }))).toBe('hello there');
  });
});

describe('estimateUserTurnHeight', () => {
  it.each([null, '', 'short'])('keeps a minimum text line for %s', (text) => {
    expect(estimateUserTurnHeight(text, 0, false, 10)).toBe(84);
  });

  it('caps an unmeasured long message at its default collapsed height', () => {
    expect(estimateUserTurnHeight('x'.repeat(100_000), 0, false, 10)).toBe(300);
    expect(estimateUserTurnHeight('x'.repeat(51), 0, false, 10)).toBe(108);
  });

  it('keeps the full text estimate after explicit expansion', () => {
    expect(estimateUserTurnHeight('x'.repeat(100_000), 0, true, 10)).toBe(48_060);
  });

  it('counts attachment height independently of the collapsed text limit', () => {
    expect(estimateUserTurnHeight('x'.repeat(100_000), 2, false, 10)).toBe(364);
    expect(estimateUserTurnHeight('x'.repeat(100_000), 2, true, 10)).toBe(48_124);
  });
});

describe('latestSettledDaemonTurnIds', () => {
  const settled = () => true;

  function group(daemonTurnId: number | undefined): ChatTurn[] {
    return [turn({ role: 'assistant', daemonTurnId })];
  }

  it('returns the newest settled turn ids first, capped at the limit', () => {
    const groups = [group(1), group(2), group(3), group(4), group(5)];
    expect(latestSettledDaemonTurnIds(groups, settled, 3)).toEqual([5, 4, 3]);
  });

  it('skips groups without a daemon turn id or that are not settled', () => {
    const groups = [group(1), group(undefined), group(3), group(4)];
    const isSettled = (g: readonly ChatTurn[]) => g[0]?.daemonTurnId !== 3;
    expect(latestSettledDaemonTurnIds(groups, isSettled, 3)).toEqual([4, 1]);
  });

  it('keeps scanning older groups until the limit is filled', () => {
    const groups = [group(1), group(2), group(undefined)];
    expect(latestSettledDaemonTurnIds(groups, settled, 3)).toEqual([2, 1]);
    expect(latestSettledDaemonTurnIds([], settled, 3)).toEqual([]);
  });
});

describe('assistantRenderBlocks progress updates', () => {
  function tool(id: string, name: string, status: 'ok' | 'running' | 'error' = 'ok') {
    return { kind: 'tool' as const, tool: { id, name, arg: '{}', status } };
  }

  function assistant(blocks: NonNullable<ChatTurn['blocks']>): ChatTurn {
    return turn({ id: 'a1', role: 'assistant', blocks });
  }

  it('gives a progress update its own row between activity runs', () => {
    const rendered = assistantRenderBlocks(
      assistant([
        tool('read-1', 'Read'),
        tool('read-2', 'Read'),
        tool('notify-1', 'NotifyUser'),
        tool('edit-1', 'Edit'),
        tool('edit-2', 'Edit'),
      ]),
    );
    expect(rendered.map((block) => block.kind)).toEqual(['activity-run', 'tool', 'activity-run']);
    expect(rendered[1]).toMatchObject({ kind: 'tool', tool: { id: 'notify-1' } });
  });

  it('keeps an update that is still being posted on its own row', () => {
    const rendered = assistantRenderBlocks(
      assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser', 'running')]),
    );
    expect(rendered.map((block) => block.kind)).toEqual(['tool', 'tool']);
  });

  it('leaves a failed update call inside the activity run', () => {
    const rendered = assistantRenderBlocks(
      assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser', 'error'), tool('read-2', 'Read')]),
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ kind: 'activity-run' });
  });

  it('keeps a progress row inside the activity run when NotifyUser is disabled', () => {
    const rendered = assistantRenderBlocks(
      assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser'), tool('read-2', 'Read')]),
      { notifyUserEnabled: false },
    );
    expect(rendered.map((block) => block.kind)).toEqual(['activity-run']);
    expect(rendered[0]).toMatchObject({ kind: 'activity-run' });
  });

  it('does not reuse a fold computed with a different NotifyUser flag', () => {
    const t = assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser'), tool('read-2', 'Read')]);
    expect(splitAssistantFold(t, { notifyUserEnabled: false }).folded.map((block) => block.kind)).toEqual([
      'activity-run',
    ]);
    expect(splitAssistantFold(t, { notifyUserEnabled: true }).folded.map((block) => block.kind)).toEqual([
      'tool',
      'tool',
      'tool',
    ]);
  });

  it('keeps each NotifyUser flag fold cached while callers alternate', () => {
    const t = assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser'), tool('read-2', 'Read')]);
    const off = splitAssistantFold(t, { notifyUserEnabled: false });
    const on = splitAssistantFold(t, { notifyUserEnabled: true });
    expect(splitAssistantFold(t, { notifyUserEnabled: false })).toBe(off);
    expect(splitAssistantFold(t)).toBe(on);
  });

  it('folds progress rows with the work before the reply', () => {
    const fold = splitAssistantFold(
      assistant([
        tool('read-1', 'Read'),
        tool('notify-1', 'NotifyUser'),
        tool('read-2', 'Read'),
        { kind: 'text', text: 'Fixed it.' },
      ]),
    );
    expect(fold.folded.map((block) => block.kind)).toEqual(['tool', 'tool', 'tool']);
    expect(fold.visible.map((block) => block.kind)).toEqual(['text']);
  });

  it('does not treat a progress row as the fold boundary of a turn without a reply', () => {
    const fold = splitAssistantFold(
      assistant([tool('read-1', 'Read'), tool('notify-1', 'NotifyUser'), tool('read-2', 'Read')]),
    );
    expect(fold.visible).toEqual([]);
    expect(fold.folded).toHaveLength(3);
  });

  it('keeps subagent cards standalone while bash joins activity runs', () => {
    const rendered = assistantRenderBlocks(
      assistant([
        tool('read-1', 'Read'),
        tool('bash-1', 'shell'),
        tool('read-2', 'Read'),
        tool('agent-1', 'Agent'),
        tool('read-3', 'Read'),
        tool('bash-2', 'Bash'),
        tool('read-4', 'Read'),
        tool('agent-2', 'Subagent'),
      ]),
    );
    expect(rendered.map((block) => block.kind)).toEqual(['activity-run', 'tool', 'activity-run', 'tool']);
    const foldedToolIds = rendered.flatMap((block) =>
      block.kind === 'activity-run'
        ? block.items.flatMap((item) => item.kind === 'tool' ? [item.tool.id] : [])
        : [],
    );
    expect(foldedToolIds).toEqual(['read-1', 'bash-1', 'read-2', 'read-3', 'bash-2', 'read-4']);
    const standaloneToolIds = rendered.flatMap((block) => block.kind === 'tool' ? [block.tool.id] : []);
    expect(standaloneToolIds).toEqual(['agent-1', 'agent-2']);
  });
});

describe('latestNotifyToolCallId', () => {
  function tool(id: string, name: string, status: 'ok' | 'running' | 'error' = 'ok') {
    return { kind: 'tool' as const, tool: { id, name, arg: '{}', status } };
  }

  function assistant(blocks: NonNullable<ChatTurn['blocks']>): ChatTurn {
    return turn({ id: 'a1', role: 'assistant', blocks });
  }

  it('returns the newest non-error NotifyUser call across turns', () => {
    const first = assistant([tool('n1', 'NotifyUser')]);
    const second = assistant([tool('n2', 'NotifyUser')]);
    expect(latestNotifyToolCallId([first, second])).toBe('n2');
  });

  it('skips failed NotifyUser calls and turns without one', () => {
    const first = assistant([tool('n1', 'NotifyUser')]);
    const second = assistant([tool('n2', 'NotifyUser', 'error')]);
    expect(latestNotifyToolCallId([first, second])).toBe('n1');
    expect(latestNotifyToolCallId([assistant([tool('r1', 'Read')])])).toBeUndefined();
  });
});

describe('streamingTailIndex', () => {
  function assistant(blocks: NonNullable<ChatTurn['blocks']>): ChatTurn {
    return turn({ id: 'a1', role: 'assistant', blocks });
  }

  it('does not infer a streaming tail from block position', () => {
    const t = assistant([{ kind: 'text', text: 'Previous response' }]);
    expect(streamingTailIndex(t, 'a1')).toBeNull();
  });

  it('selects the tail explicitly marked by the running step', () => {
    const t = assistant([
      { kind: 'text', text: 'Previous response' },
      { kind: 'thinking', thinking: 'Current step', streaming: true },
    ]);
    expect(streamingTailIndex(t, 'a1')).toBe(1);
    expect(streamingTailIndex(t, 'other-turn')).toBeNull();
  });

  it('does not fall back to an earlier streaming block behind a settled tail', () => {
    const t = assistant([
      { kind: 'text', text: 'Current step', streaming: true },
      { kind: 'text', text: 'Next step' },
    ]);
    expect(streamingTailIndex(t, 'a1')).toBeNull();
  });

  it('keeps completed thinking and pending tool interactions parked', () => {
    const thinking = assistant([{ kind: 'thinking', thinking: 'Done', durationMs: 1, streaming: true }]);
    expect(streamingTailIndex(thinking, 'a1')).toBeNull();

    const tool = assistant([{
      kind: 'tool',
      tool: { id: 'call-1', name: 'Read', arg: '{}', status: 'running' },
      streaming: true,
    }]);
    expect(streamingTailIndex(tool, 'a1')).toBe(0);
    expect(streamingTailIndex(tool, 'a1', [{ toolCallId: 'call-1' }])).toBeNull();
    expect(streamingTailIndex(tool, 'a1', [], [{ toolCallId: 'call-1' }])).toBeNull();
  });
});

describe('activityRunTailIndex', () => {
  function assistant(blocks: NonNullable<ChatTurn['blocks']>): ChatTurn {
    return turn({ id: 'a1', role: 'assistant', blocks });
  }

  it('keeps the activity tail live between settled streaming steps', () => {
    const thinking = assistant([{ kind: 'thinking', thinking: 'Done', durationMs: 1 }]);
    expect(streamingTailIndex(thinking, 'a1')).toBeNull();
    expect(activityRunTailIndex(thinking, 'a1')).toBe(0);
    expect(activityRunTailIndex(thinking, 'other-turn')).toBeNull();
  });

  it('settles the activity tail behind text and parks pending interactions', () => {
    const text = assistant([{ kind: 'text', text: 'Response', streaming: true }]);
    expect(activityRunTailIndex(text, 'a1')).toBeNull();

    const thinking = assistant([{ kind: 'thinking', thinking: 'Done', durationMs: 1 }]);
    expect(activityRunTailIndex(thinking, 'a1', [{ toolCallId: 'call-1' }])).toBeNull();
    expect(activityRunTailIndex(thinking, 'a1', [], [{ toolCallId: 'call-1' }])).toBeNull();

    const tool = assistant([{
      kind: 'tool',
      tool: { id: 'call-1', name: 'Read', arg: '{}', status: 'running' },
    }]);
    expect(activityRunTailIndex(tool, 'a1')).toBe(0);
    expect(activityRunTailIndex(tool, 'a1', [{ toolCallId: 'call-1' }])).toBeNull();
    expect(activityRunTailIndex(tool, 'a1', [], [{ toolCallId: 'call-1' }])).toBeNull();
  });
});
