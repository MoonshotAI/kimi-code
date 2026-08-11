import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptPage } from '../src/api/types';
import { TranscriptChannel } from '../src/transcript/channel';

describe('TranscriptChannel', () => {
  it('notifies consumers after entering the initial loading state', async () => {
    let resolvePage!: (value: SessionTranscriptPage) => void;
    const pendingPage = new Promise<SessionTranscriptPage>((resolve) => {
      resolvePage = resolve;
    });
    const loadingStates: boolean[] = [];
    let channel!: TranscriptChannel;
    channel = new TranscriptChannel({
      sessionId: 's1',
      agentId: 'agent-a',
      fetchPage: () => pendingPage,
      onChange: () => loadingStates.push(channel.loading),
    });

    const refresh = channel.refresh();
    expect(loadingStates).toEqual([true]);
    resolvePage(page([], false, 1));
    await refresh;
    expect(loadingStates.at(-1)).toBe(false);
  });

  it('loads a cold baseline, applies sequenced live ops, and paginates older turns', async () => {
    const fetchPage = vi.fn(async (query: { beforeTurn?: string }) =>
      query.beforeTurn
        ? page([turn('t1', 1)], false, 4, 'turn')
        : page([turn('t2', 2)], true, 3),
    );
    const channel = new TranscriptChannel({
      sessionId: 's1',
      agentId: 'agent-a',
      fetchPage,
    });

    await channel.refresh();
    channel.applyOps([{ op: 'meta.merge', meta: { activity: 'turn' } }], 4);
    await channel.loadOlder();

    expect(channel.seq).toBe(4);
    expect(channel.agents).toEqual([
      expect.objectContaining({ agentId: 'agent-a', label: 'Inspector' }),
    ]);
    expect(channel.snapshot.meta.activity).toBe('turn');
    expect(
      channel.snapshot.items
        .filter((item) => item.kind === 'turn')
        .map((item) => item.turnId),
    ).toEqual(['t1', 't2']);
    expect(channel.snapshot.hasMoreOlder).toBe(false);
  });

  it('does not apply an out-of-order live batch', async () => {
    const onGap = vi.fn();
    const channel = new TranscriptChannel({
      sessionId: 's1',
      agentId: 'agent-a',
      fetchPage: async () => page([], false, 5),
      onGap,
    });
    await channel.refresh();

    channel.applyOps([{ op: 'meta.merge', meta: { activity: 'turn' } }], 7);

    expect(onGap).toHaveBeenCalledOnce();
    expect(channel.snapshot.meta.activity).toBeUndefined();
    expect(channel.seq).toBe(5);
  });

  it('replays live ops buffered while loading an older page', async () => {
    let resolveOlder!: (value: SessionTranscriptPage) => void;
    const olderPage = new Promise<SessionTranscriptPage>((resolve) => {
      resolveOlder = resolve;
    });
    const fetchPage = vi.fn((query: { beforeTurn?: string }) =>
      query.beforeTurn
        ? olderPage
        : Promise.resolve(page([textTurn('t2', 2, 'A')], true, 3)),
    );
    const channel = new TranscriptChannel({
      sessionId: 's1',
      agentId: 'agent-a',
      fetchPage,
    });

    await channel.refresh();
    const loadingOlder = channel.loadOlder();
    expect(channel.applyOps(
      [{
        op: 'append',
        target: {
          type: 'frame',
          turnId: 't2',
          stepId: 't2:1',
          frameId: 't2:f1',
        },
        offset: 1,
        text: 'B',
      }],
      4,
    )).toBe(false);
    resolveOlder(page([turn('t1', 1)], false, 4));
    await loadingOlder;

    const current = channel.snapshot.items.find(
      (item) => item.kind === 'turn' && item.turnId === 't2',
    );
    expect(current).toMatchObject({
      steps: [{
        frames: [{ kind: 'text', text: 'AB' }],
      }],
    });
    expect(channel.seq).toBe(4);
  });
});

function turn(turnId: string, ordinal: number) {
  return {
    kind: 'turn' as const,
    turnId,
    ordinal,
    state: 'completed' as const,
    origin: { kind: 'task' as const, taskId: 'task-1' },
    steps: [],
  };
}

function textTurn(turnId: string, ordinal: number, text: string) {
  return {
    ...turn(turnId, ordinal),
    state: 'running' as const,
    steps: [{
      kind: 'step' as const,
      stepId: `${turnId}:1`,
      turnId,
      ordinal: 1,
      state: 'running' as const,
      frames: [{
        kind: 'text' as const,
        frameId: `${turnId}:f1`,
        role: 'assistant' as const,
        text,
      }],
    }],
  };
}

function page(
  items: SessionTranscriptPage['items'],
  hasMoreOlder: boolean,
  seq: number,
  activity?: 'turn',
): SessionTranscriptPage {
  return {
    agentId: 'agent-a',
    items,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: activity === undefined ? {} : { activity },
    hasMoreOlder,
    agents: [{ agentId: 'agent-a', type: 'sub', label: 'Inspector' }],
    pendingInteractions: [],
    seq,
  };
}
