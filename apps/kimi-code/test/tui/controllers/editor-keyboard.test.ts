import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOUBLE_ESC_WINDOW_MS } from '#/tui/constant/kimi-tui';
import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

interface Harness {
  readonly host: EditorKeyboardHost;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  readonly openUndoSelector: ReturnType<typeof vi.fn>;
  readonly cancelRunningShellCommand: ReturnType<typeof vi.fn>;
}

function createHarness(options: { streamingPhase?: string; isCompacting?: boolean } = {}): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = vi.fn();
  const cancelRunningShellCommand = vi.fn();
  const session = { cancel: vi.fn(async () => {}) };

  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: {
        streamingPhase: options.streamingPhase ?? 'idle',
        isCompacting: options.isCompacting ?? false,
      },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
    btwPanelController: { closeOrCancel: vi.fn(() => false) },
    openUndoSelector,
    cancelRunningShellCommand,
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
  );
  controller.install();

  return { host, editor, openUndoSelector, cancelRunningShellCommand };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressNonEscape(editor: Harness['editor']): void {
  const handler = editor['onNonEscapeInput'];
  if (handler === undefined) throw new Error('onNonEscapeInput handler not installed');
  (handler as () => void)();
}

describe('EditorKeyboardController double-Esc undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the undo selector when Esc is pressed twice within the window while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    expect(openUndoSelector).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(openUndoSelector).toHaveBeenCalledOnce();
  });

  it('does nothing for a single Esc while idle', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when the second Esc arrives after the window expires', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    vi.advanceTimersByTime(DOUBLE_ESC_WINDOW_MS + 1);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger when another key is pressed between the two Esc presses', () => {
    const { editor, openUndoSelector } = createHarness();

    pressEscape(editor);
    pressNonEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
  });

  it('does not trigger undo while streaming; Esc cancels the stream instead', () => {
    const { editor, host, openUndoSelector, cancelRunningShellCommand } = createHarness({
      streamingPhase: 'waiting',
    });

    pressEscape(editor);
    pressEscape(editor);

    expect(openUndoSelector).not.toHaveBeenCalled();
    expect(cancelRunningShellCommand).toHaveBeenCalled();
    const session = host.session as unknown as { cancel: ReturnType<typeof vi.fn> };
    expect(session.cancel).toHaveBeenCalled();
  });
});

describe('EditorKeyboardController shell history recall', () => {
  type Recall = (entry: string, direction: 1 | -1) => string | undefined;
  type Mock = ReturnType<typeof vi.fn>;

  it('installs a filter that allows shell entries only in bash mode', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    expect(setHistoryFilter).toHaveBeenCalledOnce();
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(true);

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(filter('!cmd')).toBe(true);
    expect(filter('hello')).toBe(false);
  });

  it('locks the filter to the browse-entry mode once browsing starts', () => {
    const { editor } = createHarness();
    const setHistoryFilter = editor['setHistoryFilter'] as unknown as Mock;
    const [filter] = setHistoryFilter.mock.calls[0] as [(entry: string) => boolean];
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    // Enter browse from prompt mode, then simulate landing on a shell entry
    // (which flips inputMode to bash). The filter should stay locked to prompt
    // and keep allowing plain entries.
    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    save();
    (editor as unknown as { inputMode: string }).inputMode = 'bash';

    expect(filter('hello')).toBe(true);
    expect(filter('!cmd')).toBe(true);
  });

  it('strips the leading ! and switches to bash mode when recalling a shell entry', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('!cmd', -1);

    expect(result).toBe('cmd');
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('bash');
  });

  it('keeps plain entries as-is and switches to prompt mode', () => {
    const { editor } = createHarness();
    const onRecall = editor['onRecall'] as unknown as Recall;

    const result = onRecall('hello', -1);

    expect(result).toBeUndefined();
    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });

  it('saves the current input mode as the history draft host state', () => {
    const { editor } = createHarness();
    const save = editor['onHistoryDraftSave'] as unknown as () => unknown;

    (editor as unknown as { inputMode: string }).inputMode = 'prompt';
    expect(save()).toBe('prompt');

    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    expect(save()).toBe('bash');
  });

  it('restores the input mode from the saved draft host state', () => {
    const { editor } = createHarness();
    const restore = editor['onHistoryDraftRestore'] as unknown as (state: unknown) => void;

    restore('prompt');

    expect(editor['setInputMode'] as unknown as Mock).toHaveBeenCalledWith('prompt');
  });
});
