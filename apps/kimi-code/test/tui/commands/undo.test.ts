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

function hostWith(entries: TranscriptEntry[]): SlashCommandHost {
  return {
    session: { undoHistory: vi.fn(async () => {}) },
    state: {
      transcriptEntries: entries,
      transcriptContainer: { children: [], addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      appState: { streamingPhase: 'idle' },
    },
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe('/undo with bundled prompts', () => {
  it('removes the bundle cards with their prompt, keeping a standalone skill card before them', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'earlier question' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
      }),
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: security',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual([
      'earlier question',
      'Activated skill: review',
      'prompt one',
      'answer one',
    ]);
  });

  it('removes bundle cards around an interleaved hook result and keeps the hook result', async () => {
    const entries: TranscriptEntry[] = [
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'assistant', content: 'hook note', hookResult: true }),
      entry({ kind: 'user', content: 'bundled prompt' }),
      entry({ kind: 'assistant', content: 'bundled answer' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual(['hook note']);
  });

  it('does not count bundle cards as undo anchors of their own', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '2');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(2);
    expect(entries).toHaveLength(0);
  });
});

describe('/undo todo panel refresh', () => {
  function hostWithTodos(
    entries: TranscriptEntry[],
    session: Record<string, unknown>,
  ): { host: SlashCommandHost; setTodoList: ReturnType<typeof vi.fn> } {
    const host = hostWith(entries);
    const setTodoList = vi.fn();
    (host as { streamingUI?: unknown }).streamingUI = { setTodoList };
    (host as { session?: unknown }).session = session;
    return { host, setTodoList };
  }

  it('re-pulls the engine todo state after a successful undo', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => [{ title: 'kept', status: 'pending' }]),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).toHaveBeenCalledWith([{ title: 'kept', status: 'pending' }]);
  });

  it('keeps the panel as-is when the engine has no todo read surface', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => {
        throw new Error('getTodos is only available on the agent-core-v2 engine.');
      }),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).not.toHaveBeenCalled();
  });

  it('hides the panel when the restored todos are all done', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => [{ title: 'finished', status: 'done' }]),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).toHaveBeenCalledWith([]);
  });
});
