import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOUBLE_ESC_WINDOW_MS, NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/kimi-tui';
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
  readonly cancelCompaction: ReturnType<typeof vi.fn>;
  readonly btwCancelRunning: ReturnType<typeof vi.fn>;
  readonly btwCloseOrCancel: ReturnType<typeof vi.fn>;
}

function createHarness(options: { streamingPhase?: string; isCompacting?: boolean } = {}): Harness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
    getText: vi.fn(() => '') as unknown as (...args: never[]) => unknown,
    setText: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const openUndoSelector = vi.fn();
  const cancelRunningShellCommand = vi.fn();
  const cancelCompaction = vi.fn(async () => {});
  const btwCancelRunning = vi.fn(() => false);
  const btwCloseOrCancel = vi.fn(() => false);
  const session = { cancel: vi.fn(async () => {}), cancelCompaction };

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
    btwPanelController: { cancelRunning: btwCancelRunning, closeOrCancel: btwCloseOrCancel },
    openUndoSelector,
    cancelRunningShellCommand,
    updateEditorBorderHighlight: vi.fn(),
    updateGoalLengthWarning: vi.fn(),
  } as unknown as EditorKeyboardHost;

  const controller = new EditorKeyboardController(
    host,
    undefined as unknown as ImageAttachmentStore,
  );
  controller.install();

  return {
    host,
    editor,
    openUndoSelector,
    cancelRunningShellCommand,
    cancelCompaction,
    btwCancelRunning,
    btwCloseOrCancel,
  };
}

function pressEscape(editor: Harness['editor']): void {
  const handler = editor['onEscape'];
  if (handler === undefined) throw new Error('onEscape handler not installed');
  (handler as () => void)();
}

function pressCtrlC(editor: Harness['editor']): void {
  const handler = editor['onCtrlC'];
  if (handler === undefined) throw new Error('onCtrlC handler not installed');
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

describe('EditorKeyboardController btw panel priority', () => {
  it('Esc closes the btw panel first while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Esc cancels compaction on the next press once the btw panel is gone', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValueOnce(true);

    pressEscape(editor);
    expect(cancelCompaction).not.toHaveBeenCalled();

    pressEscape(editor);
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Esc cancels compaction directly when no btw panel is open', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });

    pressEscape(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('Ctrl+C cancels a running btw question first while compacting', () => {
    const { editor, btwCancelRunning, cancelCompaction } = createHarness({ isCompacting: true });
    btwCancelRunning.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C closes an idle btw panel while compacting, without cancelling compaction', () => {
    const { editor, btwCloseOrCancel, cancelCompaction } = createHarness({ isCompacting: true });
    btwCloseOrCancel.mockReturnValue(true);

    pressCtrlC(editor);

    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).not.toHaveBeenCalled();
  });

  it('Ctrl+C cancels compaction when no btw panel is open', () => {
    const { editor, btwCancelRunning, btwCloseOrCancel, cancelCompaction } = createHarness({
      isCompacting: true,
    });

    pressCtrlC(editor);

    expect(btwCancelRunning).toHaveBeenCalledOnce();
    expect(btwCloseOrCancel).toHaveBeenCalledOnce();
    expect(cancelCompaction).toHaveBeenCalledOnce();
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

describe('EditorKeyboardController input changes', () => {
  function installExpandedText(
    editor: Harness['editor'],
    expanded: string,
  ): ReturnType<typeof vi.fn> {
    const getExpandedText = vi.fn(() => expanded);
    editor['getExpandedText'] = getExpandedText as unknown as (...args: never[]) => unknown;
    return getExpandedText;
  }

  it('forwards text changes to the border highlight and goal length warning', () => {
    const { host, editor } = createHarness();
    installExpandedText(editor, '/goal Ship feature X');
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('/goal Ship feature X');

    expect(host.updateEditorBorderHighlight).toHaveBeenCalledWith('/goal Ship feature X');
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith('/goal Ship feature X');
  });

  it('measures the goal length warning on paste-expanded text, not the collapsed marker', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    // The visible text only holds the collapsed paste marker.
    onChange('/goal [paste #1 +4000 chars]');

    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('expands a leading paste marker because its content may start with /goal', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('[paste #1 +4000 chars]');

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('expands a paste that can complete a partially typed /goal command', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    // Visible text is `/go[paste #1 …]`; the paste completes the command.
    onChange('/go[paste #1 +3999 chars]');

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('skips paste expansion entirely for non-goal input', () => {
    const { host, editor } = createHarness();
    const getExpandedText = installExpandedText(editor, 'whatever');
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('just a normal prompt');
    onChange('/help');

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(undefined);
  });

  it('gates on trimmed text because submit trims leading whitespace', () => {
    const { host, editor } = createHarness();
    const expanded = `/goal ${'x'.repeat(4001)}`;
    const getExpandedText = installExpandedText(editor, expanded);
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange(`  /goal ${'x'.repeat(4001)}`);

    expect(getExpandedText).toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(expanded);
  });

  it('skips the goal length warning in bash mode', () => {
    const { host, editor } = createHarness();
    const getExpandedText = installExpandedText(editor, '/goal x');
    (editor as unknown as { inputMode: string }).inputMode = 'bash';
    const onChange = editor['onChange'] as unknown as (text: string) => void;

    onChange('/goal x');

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(host.updateGoalLengthWarning).toHaveBeenCalledWith(undefined);
  });
});

describe('EditorKeyboardController Shift-Tab plan toggle', () => {
  function createShiftTabHarness(options: { sessionless?: boolean; engineV2?: boolean } = {}) {
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    };
    const handlePlanToggle = vi.fn();
    const track = vi.fn();
    const showError = vi.fn();
    const ensureSession = vi.fn(async (): Promise<{ id: string } | undefined> => ({ id: 'ses-lazy' }));
    const host = {
      state: {
        editor,
        activeDialog: null,
        appState: { streamingPhase: 'idle', isCompacting: false, planMode: false },
        footer: { setTransientHint: vi.fn() },
        ui: { requestRender: vi.fn() },
      },
      session: options.sessionless ? undefined : { cancel: vi.fn(async () => {}) },
      engineV2: options.engineV2 ?? false,
      ensureSession,
      handlePlanToggle,
      track,
      showError,
      btwPanelController: { cancelRunning: vi.fn(), closeOrCancel: vi.fn() },
    } as unknown as EditorKeyboardHost;

    new EditorKeyboardController(host, undefined as unknown as ImageAttachmentStore).install();
    const onShiftTab = editor['onShiftTab'] as unknown as () => void;
    return { onShiftTab, handlePlanToggle, track, showError, ensureSession };
  }

  it('toggles plan mode directly with an active session', () => {
    const { onShiftTab, handlePlanToggle, ensureSession } = createShiftTabHarness();

    onShiftTab();

    expect(ensureSession).not.toHaveBeenCalled();
    expect(handlePlanToggle).toHaveBeenCalledWith(true);
  });

  it('reports no active session on v1 when session-less', () => {
    const { onShiftTab, showError, handlePlanToggle } = createShiftTabHarness({
      sessionless: true,
    });

    onShiftTab();

    expect(showError).toHaveBeenCalledWith(NO_ACTIVE_SESSION_MESSAGE);
    expect(handlePlanToggle).not.toHaveBeenCalled();
  });

  it('lazy-creates the session before toggling on v2 when session-less', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle, track } = createShiftTabHarness({
      sessionless: true,
      engineV2: true,
    });

    onShiftTab();
    expect(handlePlanToggle).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(handlePlanToggle).toHaveBeenCalledWith(true);
    });
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith('shortcut_plan_toggle', { enabled: true });
  });

  it('does not toggle when the lazy creation fails on v2', async () => {
    const { onShiftTab, ensureSession, handlePlanToggle } = createShiftTabHarness({
      sessionless: true,
      engineV2: true,
    });
    ensureSession.mockResolvedValue(undefined);

    onShiftTab();
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlePlanToggle).not.toHaveBeenCalled();
  });
});

/**
 * Ctrl-S steering of the TUI queue: plain-text items steer as messages,
 * slash-skill items fire as real activations into the running turn (never as
 * literal text), grouped inline-skill submissions stay queued for the drain
 * path, bash items stay queued — all in queue order.
 */
describe('EditorKeyboardController Ctrl-S steering', () => {
  function createCtrlSHarness(options: {
    editorText: string;
    queued: Array<Record<string, unknown>>;
    engineV2?: boolean;
    skillCommandMap?: Map<string, string>;
  }) {
    const steerMessage = vi.fn();
    const steerSkillActivation = vi.fn();
    const updateQueueDisplay = vi.fn();
    const setText = vi.fn();
    const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
      setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
      setInputMode: vi.fn() as unknown as (...args: never[]) => unknown,
      getText: vi.fn(() => options.editorText) as unknown as (...args: never[]) => unknown,
      setText: setText as unknown as (...args: never[]) => unknown,
      inputMode: 'prompt' as unknown as (...args: never[]) => unknown,
    };
    const host = {
      state: {
        editor,
        activeDialog: null,
        queuedMessages: options.queued,
        appState: { streamingPhase: 'waiting', isCompacting: false, model: 'k2' },
        footer: { setTransientHint: vi.fn() },
        ui: { requestRender: vi.fn() },
      },
      session: { id: 's1' },
      engineV2: options.engineV2 ?? false,
      skillCommandMap: options.skillCommandMap ?? new Map(),
      steerMessage,
      steerSkillActivation,
      updateQueueDisplay,
      validateMediaCapabilities: vi.fn(() => true),
      showError: vi.fn(),
      track: vi.fn(),
      btwPanelController: {
        cancelRunning: vi.fn(() => false),
        closeOrCancel: vi.fn(() => false),
      },
    } as unknown as EditorKeyboardHost;
    const controller = new EditorKeyboardController(
      host,
      undefined as unknown as ImageAttachmentStore,
    );
    controller.install();
    const onCtrlS = editor['onCtrlS'];
    if (onCtrlS === undefined) throw new Error('onCtrlS handler not installed');
    return {
      host,
      editor,
      setText,
      steerMessage,
      steerSkillActivation,
      updateQueueDisplay,
      onCtrlS: onCtrlS as () => void,
    };
  }

  it('steers text as a message, skill items as activations, and keeps bash queued', () => {
    const { host, steerMessage, steerSkillActivation, updateQueueDisplay, onCtrlS } =
      createCtrlSHarness({
        editorText: '',
        queued: [
          { text: 'queued text', agentId: 'main' },
          {
            text: '/tower status',
            agentId: 'main',
            mode: 'skill',
            skillName: 'tower',
            skillArgs: 'status',
          },
          { text: '!ls', agentId: 'main', mode: 'bash' },
        ],
      });

    onCtrlS();

    expect(steerMessage).toHaveBeenCalledWith(host.session, [
      { text: 'queued text', parts: undefined, imageAttachmentIds: undefined },
    ]);
    expect(steerSkillActivation).toHaveBeenCalledWith(host.session, 'tower', 'status');
    expect(host.state.queuedMessages).toEqual([{ text: '!ls', agentId: 'main', mode: 'bash' }]);
    expect(updateQueueDisplay).toHaveBeenCalled();
  });

  it('steers plain queued messages but keeps grouped inline-skill submissions queued', () => {
    const { host, steerMessage, updateQueueDisplay, onCtrlS } = createCtrlSHarness({
      editorText: '',
      queued: [
        { text: 'plain note', agentId: 'main' },
        {
          text: 'check /skill:review',
          agentId: 'main',
          inlineSkillActivations: [{ skillName: 'review' }],
        },
      ],
    });

    onCtrlS();

    expect(steerMessage).toHaveBeenCalledWith(host.session, [
      { text: 'plain note', parts: undefined, imageAttachmentIds: undefined },
    ]);
    expect(host.state.queuedMessages).toEqual([
      {
        text: 'check /skill:review',
        agentId: 'main',
        inlineSkillActivations: [{ skillName: 'review' }],
      },
    ]);
    expect(updateQueueDisplay).toHaveBeenCalled();
  });

  it('stops steering at the first bundle so later messages keep FIFO order', () => {
    const { host, steerMessage, onCtrlS } = createCtrlSHarness({
      editorText: '',
      queued: [
        { text: 'earlier note', agentId: 'main' },
        {
          text: 'check /skill:review',
          agentId: 'main',
          inlineSkillActivations: [{ skillName: 'review' }],
        },
        { text: 'later note', agentId: 'main' },
      ],
    });

    onCtrlS();

    expect(steerMessage).toHaveBeenCalledWith(host.session, [
      { text: 'earlier note', parts: undefined, imageAttachmentIds: undefined },
    ]);
    expect(host.state.queuedMessages).toEqual([
      {
        text: 'check /skill:review',
        agentId: 'main',
        inlineSkillActivations: [{ skillName: 'review' }],
      },
      { text: 'later note', agentId: 'main' },
    ]);
  });

  it('steers nothing when a bundle leads the queue', () => {
    const { host, steerMessage, onCtrlS } = createCtrlSHarness({
      editorText: '',
      queued: [
        {
          text: 'check /skill:review',
          agentId: 'main',
          inlineSkillActivations: [{ skillName: 'review' }],
        },
        { text: 'later note', agentId: 'main' },
      ],
    });

    onCtrlS();

    expect(steerMessage).not.toHaveBeenCalled();
    expect(host.state.queuedMessages).toHaveLength(2);
  });

  it('leaves an editor draft with inline skill tokens in the editor for the grouped path', () => {
    const { host, setText, steerMessage, onCtrlS } = createCtrlSHarness({
      editorText: 'check /skill:review',
      queued: [{ text: 'plain note', agentId: 'main' }],
      engineV2: true,
      skillCommandMap: new Map([['skill:review', 'review']]),
    });

    onCtrlS();

    expect(steerMessage).toHaveBeenCalledWith(host.session, [
      { text: 'plain note', parts: undefined, imageAttachmentIds: undefined },
    ]);
    expect(setText).not.toHaveBeenCalled();
    expect(host.state.queuedMessages).toEqual([]);
  });
});
