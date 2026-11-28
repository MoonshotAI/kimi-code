import {
  getKeybindings,
  renderComponentLines,
  ScrollView,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Terminal,
} from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { StickyUserMessageComponent } from '#/tui/components/messages/sticky-user-message';
import { TranscriptView } from '#/tui/components/messages/transcript-view';
import type { SelectionCopyMode, WheelScrollLines } from '#/tui/config';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import { mountFooter } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

const clipboardText = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => Promise<'native' | 'osc52'>>(async () => 'native'),
  readClipboardText: vi.fn<() => Promise<string>>(async () => ''),
}));
vi.mock('#/utils/clipboard/clipboard-text', () => clipboardText);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeInitialAppState(): AppState {
  return {
    model: 'test-model',
    workDir: '/tmp/kimi-test',
    additionalDirs: [],
    sessionId: 'sess-1',
    permissionMode: 'manual',
    planMode: false,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

describe('createTUIState', () => {
  it('initializes all fields with sensible defaults', () => {
    const opts: KimiTUIOptions = {
      initialAppState: fakeInitialAppState(),
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    };
    const state = createTUIState(opts);

    expect(state.ui).toBeDefined();
    expect(state.terminal).toBeDefined();
    expect(state.transcriptContainer).toBeDefined();
    expect(state.activityContainer).toBeDefined();
    expect(state.queueContainer).toBeDefined();
    expect(state.surveyContainer).toBeDefined();
    expect(state.editorContainer).toBeDefined();
    expect(state.editor).toBeDefined();
    expect(state.footer).toBeDefined();
    expect(state.notifyPanelContainer).toBeDefined();
    expect(state.notifyPanel).toBeDefined();
    expect(state.theme.palette).toBeDefined();

    expect(state.appState).not.toBe(opts.initialAppState);
    expect(state.appState.model).toBe('test-model');
    expect(state.appState.additionalDirs).toEqual([]);
    expect(state.appState.sessionId).toBe('sess-1');
    expect(state.startupState).toBe('pending');

    expect(state.livePane.mode).toBe('idle');
    expect(state.livePane.pendingApproval).toBeNull();
    expect(state.livePane.pendingQuestion).toBeNull();

    expect(state.transcriptEntries).toHaveLength(0);
    expect(state.queuedMessages).toHaveLength(0);

    expect(state.transcriptContainer.toolOutputExpanded).toBe(false);
    expect(state.activeDialog).toBeNull();
    expect(state.externalEditorRunning).toBe(false);
    expect(state.loadingSessions).toBe(false);
    expect(state.sessionsScope).toBe('cwd');
    expect(state.activitySpinner).toBeNull();
  });

  it('uses the main-screen renderer by default', () => {
    const state = createTUIState({
      initialAppState: fakeInitialAppState(),
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });

    expect(state.ui).toBeInstanceOf(TuiMainScreen);
    expect(state.ui.mode).toBe('regular');
    expect(state.dockContainer).toBeUndefined();
  });

  it('uses resolvedTuiMode without mutating appState.tuiMode when tui.toml left tui_mode unset', () => {
    const state = createTUIState({
      initialAppState: fakeInitialAppState(),
      resolvedTuiMode: 'fullscreen',
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });

    expect(state.ui).toBeInstanceOf(TuiAltScreen);
    expect(state.ui.mode).toBe('fullscreen');
    expect(state.appState.tuiMode).toBeUndefined();
  });

  it('starts the fullscreen renderer with the saved selection copy mode', () => {
    const startWith = (selectionCopyMode: SelectionCopyMode | undefined) => {
      const state = createTUIState({
        initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen', selectionCopyMode },
        startup: { continueLast: false, yolo: false, auto: false, plan: false },
      });
      const ui = state.ui as TuiAltScreen;
      return { immediate: ui.getCopyOnSelect(), rightClick: ui.getCopyOnRightClick() };
    };

    expect(startWith(undefined)).toEqual({ immediate: true, rightClick: false });
    expect(startWith('off')).toEqual({ immediate: false, rightClick: false });
    expect(startWith('immediate')).toEqual({ immediate: true, rightClick: false });
    expect(startWith('right-click')).toEqual({ immediate: false, rightClick: true });
  });

  it('enables select-all in the fullscreen search input', () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });

    expect((state.ui as unknown as { searchSelectAll: boolean }).searchSelectAll).toBe(true);
    expect((state.ui as unknown as { editorSelection: boolean }).editorSelection).toBe(true);
  });

  it('defaults wheel scrolling to auto and keeps official Alt acceleration enabled', () => {
    const startWith = (wheelScrollLines?: WheelScrollLines) => {
      const state = createTUIState({
        initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen', wheelScrollLines },
        startup: { continueLast: false, yolo: false, auto: false, plan: false },
      });
      return state.ui as unknown as {
        wheelScroll: { lines: 'auto' | number };
        altWheelAcceleration: boolean;
      };
    };

    expect(startWith().wheelScroll.lines).toBe('auto');
    expect(startWith().altWheelAcceleration).toBe(true);
    const configured = startWith(4);
    expect(configured.wheelScroll.lines).toBe(4);
    expect(configured.altWheelAcceleration).toBe(true);
  });

  async function mountFullscreenWheelProbe(wheelScrollLines?: WheelScrollLines): Promise<{
    ui: TuiAltScreen;
    vt: VirtualTerminal;
  }> {
    const state = createTUIState({
      initialAppState: {
        ...fakeInitialAppState(),
        tuiMode: 'fullscreen',
        wheelScrollLines,
      },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    const ui = state.ui as TuiAltScreen;
    const vt = new VirtualTerminal(80, 12);
    (ui as { terminal: Terminal }).terminal = vt;
    state.transcriptContainer.addChild(
      new Text(Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n'), 0, 0),
    );
    ui.start();
    onTestFinished(() => {
      ui.stop();
    });
    await vt.waitForRender();
    return { ui, vt };
  }

  it.each<readonly [number]>([[5], [2]])(
    'starts the fullscreen renderer with configured wheelScrollLines = %d',
    async (lines) => {
      const { ui, vt } = await mountFullscreenWheelProbe(lines);
      const before = ui.viewportTop;
      expect(before).toBeGreaterThan(lines);

      vt.sendInput('\u001B[<64;1;1M');
      await vt.waitForRender();

      expect(before - ui.viewportTop).toBe(lines);
    },
  );

  it('defaults unset wheelScrollLines to auto instead of pi-tui fixed 1 line', async () => {
    vi.stubEnv('SSH_CONNECTION', '1');
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    onTestFinished(() => {
      nowSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    const { ui, vt } = await mountFullscreenWheelProbe(undefined);
    const start = ui.viewportTop;
    expect(start).toBeGreaterThan(10);

    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    const afterFirst = ui.viewportTop;
    expect(start - afterFirst).toBe(1);

    now += 25;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(afterFirst - ui.viewportTop).toBeGreaterThan(1);
  });

  it('builds an alternate-screen renderer with a docked layout in fullscreen mode', () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });

    expect(state.ui).toBeInstanceOf(TuiAltScreen);
    expect(state.ui.mode).toBe('fullscreen');

    const dock = state.dockContainer;
    expect(dock).toBeDefined();
    expect(dock?.children).toEqual([
      state.activityContainer,
      state.notifyPanelContainer,
      state.queueContainer,
      state.btwPanelContainer,
      state.surveyContainer,
      state.editorSlot,
    ]);
    expect(state.editorSlot?.children).toEqual([state.editorContainer]);

    expect((state.ui as TuiAltScreen).getLayoutRoot()).toBeDefined();
    expect(state.ui.children).toHaveLength(0);

    const rootChildren = ((state.ui as TuiAltScreen).getLayoutRoot() as VStack).children;
    expect(rootChildren[0]).toBeInstanceOf(TranscriptView);
    const transcriptChildren = (rootChildren[0] as TranscriptView).children;
    expect((transcriptChildren[0] as GutterContainer).children[0]).toBeInstanceOf(
      StickyUserMessageComponent,
    );
    expect(transcriptChildren[1]).toBeInstanceOf(ScrollView);
    expect(rootChildren[1]).toBe(state.dockContainer);

    const scrollView = transcriptChildren[1] as ScrollView;
    expect(scrollView.scrollbarLayout).toBe('dedicated');
    const padding = renderComponentLines(scrollView, 20)[0];
    expect(padding?.text).toBe(' ');
    expect(padding?.selectionRegion?.content.text).toBe('');
    expect(padding?.selectionRegion?.column).toBe(0);
    expect(padding?.selectionRegion?.width).toBe(19);

    const internals = state.ui as unknown as {
      openUrl?: (url: string) => void;
      onRightClickPaste?: () => void;
    };
    expect(typeof internals.openUrl).toBe('function');
    expect(typeof internals.onRightClickPaste).toBe('function');
  });

  describe('right-click paste', () => {
    function setup(read: () => Promise<string>) {
      clipboardText.readClipboardText.mockReset();
      clipboardText.readClipboardText.mockImplementation(read);
      const state = createTUIState({
        initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
        startup: { continueLast: false, yolo: false, auto: false, plan: false },
      });
      const ui = state.ui as TuiAltScreen;
      ui.setFocus(state.editor);
      const dispatchInput = vi.spyOn(ui, 'dispatchInput').mockImplementation(() => {});
      const onRightClickPaste = (
        ui as unknown as {
          onRightClickPaste: (request: { isCurrent(): boolean }) => void;
        }
      ).onRightClickPaste;
      return { state, ui, dispatchInput, onRightClickPaste };
    }

    it('does not read the clipboard when the request is already stale', () => {
      const read = deferred<string>();
      const { dispatchInput, onRightClickPaste } = setup(() => read.promise);
      const isCurrent = vi.fn(() => false);

      onRightClickPaste({ isCurrent });

      expect(isCurrent).toHaveBeenCalledOnce();
      expect(clipboardText.readClipboardText).not.toHaveBeenCalled();
      expect(dispatchInput).not.toHaveBeenCalled();
    });

    it('does not dispatch clipboard text when the request becomes stale during the read', async () => {
      const read = deferred<string>();
      const { dispatchInput, onRightClickPaste } = setup(() => read.promise);
      let current = true;
      const isCurrent = vi.fn(() => current);

      onRightClickPaste({ isCurrent });
      expect(clipboardText.readClipboardText).toHaveBeenCalledOnce();
      current = false;
      read.resolve('stale clipboard text');
      await read.promise;

      expect(dispatchInput).not.toHaveBeenCalled();
      expect(isCurrent).toHaveBeenCalledTimes(2);
    });

    it('dispatches one bracketed paste when the request and focused target remain current', async () => {
      const read = deferred<string>();
      const { dispatchInput, onRightClickPaste } = setup(() => read.promise);
      const isCurrent = vi.fn(() => true);

      onRightClickPaste({ isCurrent });
      read.resolve('clipboard text');
      await read.promise;

      expect(dispatchInput).toHaveBeenCalledOnce();
      expect(dispatchInput).toHaveBeenCalledWith('\u001B[200~clipboard text\u001B[201~');
      expect(isCurrent).toHaveBeenCalledTimes(2);
    });

    it('does not dispatch clipboard text when focus changes during the read', async () => {
      const read = deferred<string>();
      const { ui, dispatchInput, onRightClickPaste } = setup(() => read.promise);
      const isCurrent = vi.fn(() => true);

      onRightClickPaste({ isCurrent });
      ui.setFocus(null);
      read.resolve('clipboard text');
      await read.promise;

      expect(dispatchInput).not.toHaveBeenCalled();
      expect(isCurrent).toHaveBeenCalledTimes(2);
    });

    it('flashes clipboard read errors', async () => {
      const read = deferred<string>();
      const { ui, dispatchInput, onRightClickPaste } = setup(() => read.promise);
      const flash = vi.spyOn(ui, 'flash').mockImplementation(() => {});
      const isCurrent = vi.fn(() => true);

      onRightClickPaste({ isCurrent });
      read.reject(new Error('Clipboard unavailable'));
      await read.promise.catch(() => {});

      expect(flash).toHaveBeenCalledWith('Clipboard unavailable', 5000);
      expect(dispatchInput).not.toHaveBeenCalled();
    });
  });

  it('supports Ctrl+F, Ctrl+Shift+F, and Up/Down search navigation in fullscreen mode', async () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    const vt = new VirtualTerminal(100, 12);
    (state.ui as { terminal: Terminal }).terminal = vt;
    state.transcriptContainer.addChild(new Text('needle one\nmiddle\nneedle two\nend', 0, 0));
    mountFooter(state);
    state.editorContainer.addChild(state.editor);
    state.ui.setFocus(state.editor);
    state.ui.start();

    try {
      await vt.waitForRender();

      vt.sendInput('\u0006');
      vt.sendInput('needle');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(true);
      const beforeNav = vt.getViewport().find((line) => line.includes('/2'));
      expect(beforeNav).toBeDefined();

      vt.sendInput('\u001B[B');
      await vt.waitForRender();
      const afterDown = vt.getViewport().find((line) => line.includes('/2'));
      expect(afterDown).toBeDefined();
      expect(afterDown).not.toBe(beforeNav);

      vt.sendInput('\u001B[A');
      await vt.waitForRender();
      const afterUp = vt.getViewport().find((line) => line.includes('/2'));
      expect(afterUp).toBe(beforeNav);

      vt.sendInput('\u0006');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(false);

      vt.sendInput('\u001B[102;6u');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(true);

      vt.sendInput('\u001B[102;6u');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(false);

      expect(getKeybindings().getKeys('tui.altScreen.search')).toEqual(['ctrl+f', 'ctrl+shift+f']);
      expect(getKeybindings().getKeys('tui.altScreen.searchPrevious')).toEqual([
        'up',
        'shift+enter',
        'ctrl+shift+g',
      ]);
      expect(getKeybindings().getKeys('tui.altScreen.searchNext')).toEqual(['down', 'enter', 'ctrl+g']);
      expect(getKeybindings().getKeys('tui.editor.cursorRight')).toEqual(['right', 'ctrl+f']);
    } finally {
      state.ui.stop();
    }
  });

  it('keeps regular mode and Ctrl+F cursor movement unaffected', async () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'regular' },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    const vt = new VirtualTerminal(100, 12);
    (state.ui as { terminal: Terminal }).terminal = vt;
    state.ui.addChild(state.editor);
    state.ui.setFocus(state.editor);
    state.ui.start();

    try {
      await vt.waitForRender();

      vt.sendInput('ac');
      vt.sendInput('\u001B[D');
      vt.sendInput('\u0006');
      vt.sendInput('!');
      await vt.waitForRender();

      expect(state.ui).toBeInstanceOf(TuiMainScreen);
      expect(state.editor.getText()).toBe('ac!');
      expect(vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(false);
    } finally {
      state.ui.stop();
    }
  });

  it('lets fullscreen screen-takeover viewers receive Ctrl+F and opens search on Caps Lock Ctrl+F', async () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    const vt = new VirtualTerminal(100, 12);
    (state.ui as { terminal: Terminal }).terminal = vt;
    state.transcriptContainer.addChild(new Text('needle line', 0, 0));
    mountFooter(state);
    state.editorContainer.addChild(state.editor);
    state.ui.setFocus(state.editor);
    state.ui.start();

    try {
      await vt.waitForRender();

      vt.sendInput('ab');
      vt.sendInput('\u001B[D');
      vt.sendInput('\u001B[70;69u');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(true);
      expect(state.editor.getCursor().col).toBe(1);

      vt.sendInput('\u001B[70;69u');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(false);

      const viewerInputs: string[] = [];
      const takeoverViewer = {
        handleInput: (data: string) => {
          viewerInputs.push(data);
        },
        render: () => ['takeover viewer'],
        invalidate: () => {},
      };
      const takeover = beginScreenTakeover(state.ui, takeoverViewer);
      state.ui.setFocus(takeoverViewer);
      await vt.waitForRender();

      vt.sendInput('\u0006');
      await vt.waitForRender();
      expect(viewerInputs).toEqual(['\u0006']);
      expect(vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(false);

      endScreenTakeover(state.ui, takeover);
      state.ui.setFocus(state.editor);
      await vt.waitForRender();

      vt.sendInput('\u0006');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('Find in transcript'))).toBe(true);
    } finally {
      state.ui.stop();
    }
  });

  it('closes fullscreen search and routes typing to the editor when clicking the editor', async () => {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
      startup: { continueLast: false, yolo: false, auto: false, plan: false },
    });
    const vt = new VirtualTerminal(100, 12);
    (state.ui as { terminal: Terminal }).terminal = vt;
    state.transcriptContainer.addChild(new Text('needle line one\nmiddle\nneedle line two', 0, 0));
    mountFooter(state);
    state.editorContainer.addChild(state.editor);
    state.ui.setFocus(state.editor);
    state.ui.start();

    try {
      await vt.waitForRender();

      vt.sendInput('\u0006');
      vt.sendInput('needle');
      await vt.waitForRender();
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(true);
      expect(state.editor.focused).toBe(false);

      const editorRow = vt.getViewport().findIndex((line) => line.includes('>'));
      expect(editorRow).toBeGreaterThanOrEqual(0);
      vt.sendInput(`\u001B[<0;6;${editorRow + 1}M`);
      vt.sendInput(`\u001B[<0;6;${editorRow + 1}m`);
      await vt.waitForRender();

      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(false);
      expect(state.editor.focused).toBe(true);

      vt.sendInput('hello');
      await vt.waitForRender();
      expect(state.editor.getText()).toBe('hello');
      expect(vt.getViewport().some((line) => line.includes('↑ Previous · ↓ Next'))).toBe(false);
    } finally {
      state.ui.stop();
    }
  });
});
