import { describe, expect, it, vi } from 'vitest';

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

describe('/undo with grouped submissions', () => {
  it('removes only the contiguous group, keeping an earlier group that reuses the submission id', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'earlier question' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        promptSubmissionId: 'sub-1',
      }),
      entry({ kind: 'user', content: 'prompt one', promptSubmissionId: 'sub-1' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: security',
        skillTrigger: 'user-slash',
        promptSubmissionId: 'sub-1',
      }),
      entry({ kind: 'user', content: 'prompt two', promptSubmissionId: 'sub-1' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = {
      session: { undoHistory: vi.fn(async () => {}) },
      state: {
        transcriptEntries: entries,
        transcriptContainer: { children: [] },
        ui: { requestRender: vi.fn() },
        appState: { streamingPhase: 'idle' },
      },
      showError: vi.fn(),
    } as unknown as SlashCommandHost;

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual([
      'earlier question',
      'Activated skill: review',
      'prompt one',
      'answer one',
    ]);
  });
});
