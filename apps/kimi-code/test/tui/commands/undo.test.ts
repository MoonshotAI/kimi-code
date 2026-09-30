import { describe, expect, it, vi } from 'vitest';

import { UndoRef } from '@moonshot-ai/agent-core';

import { handleUndoCommand } from '#/tui/commands/undo';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptEntry } from '#/tui/types';

function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'kind' | 'content'>): TranscriptEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2, 10)}`,
    turnId: undefined,
    renderMode: 'plain',
    ...partial,
  };
}

function hostWith(entries: TranscriptEntry[]): {
  host: SlashCommandHost;
  undo: ReturnType<typeof vi.fn>;
} {
  const undo = vi.fn(async (_turns: number) => 1);
  const host = {
    session: {},
    mainAgent: () => ({
      resolve: (token: unknown) => {
        if (token !== UndoRef) throw new Error('unknown token');
        return {
          undo,
          availability: () => ({ maxTurns: 10, stoppedAtCompaction: false }),
        };
      },
    }),
    state: {
      transcriptEntries: entries,
      transcriptContainer: { children: [], addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      appState: { streamingPhase: 'idle' },
    },
    showError: vi.fn(),
    appendTranscriptEntry: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, undo };
}

describe('/undo', () => {
  it('undoes the last prompt through the undo facade and trims the transcript', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'earlier question' }),
      entry({ kind: 'assistant', content: 'earlier answer' }),
      entry({ kind: 'user', content: 'latest question' }),
      entry({ kind: 'assistant', content: 'latest answer' }),
    ];
    const { host, undo } = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(undo).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual(['earlier question', 'earlier answer']);
  });

  it('treats a standalone skill activation as its own undo anchor', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
      }),
      entry({ kind: 'assistant', content: 'skill answer' }),
    ];
    const { host, undo } = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(undo).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual(['question', 'answer']);
  });

  it('undoes multiple prompts with /undo N', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({ kind: 'user', content: 'two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const { host, undo } = hostWith(entries);

    await handleUndoCommand(host, '2');

    expect(undo).toHaveBeenCalledWith(2);
    expect(entries).toHaveLength(0);
  });

  it('reports a limit instead of calling the facade when there is nothing to undo', async () => {
    const entries: TranscriptEntry[] = [entry({ kind: 'assistant', content: 'answer only' })];
    const { host, undo } = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(undo).not.toHaveBeenCalled();
    expect(host.appendTranscriptEntry).toHaveBeenCalled();
  });

  it('refuses to undo while streaming', async () => {
    const entries: TranscriptEntry[] = [entry({ kind: 'user', content: 'question' })];
    const { host, undo } = hostWith(entries);
    (host.state.appState as { streamingPhase: string }).streamingPhase = 'waiting';

    await handleUndoCommand(host, '1');

    expect(undo).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalled();
  });
});
