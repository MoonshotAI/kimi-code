import {
  getKeybindings,
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
import type { WheelScrollLines } from '#/tui/config';
import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import { mountFooter } from '#/tui/tui-state';
import type { AppState } from '#/tui/types';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

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

  it('starts the fullscreen renderer with the saved copy-on-select choice', () => {
    const startWith = (copyOnSelect: boolean | undefined): boolean => {
      const state = createTUIState({
        initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen', copyOnSelect },
        startup: { continueLast: false, yolo: false, auto: false, plan: false },
      });
      return (state.ui as TuiAltScreen).getCopyOnSelect();
    };

    expect(startWith(undefined)).toBe(true);
    expect(startWith(false)).toBe(false);
  });

  async function mountFullscreenWheelProbe(wheelScrollLines?: WheelScrollLines): Promise<{
    ui: TuiAltScreen;
    vt: VirtualTerminal;
  }> {
    const state = createTUIState({
      initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen', wheelScrollLines },
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

    const internals = state.ui as unknown as {
      openUrl?: (url: string) => void;
      onRightClickPaste?: () => void;
    };
    expect(typeof internals.openUrl).toBe('function');
    expect(typeof internals.onRightClickPaste).toBe('function');
  });

  it('injects fullscreen search keybindings without mutating global keybindings', async () => {
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

      expect(getKeybindings().getKeys('tui.altScreen.search')).toEqual(['ctrl+shift+f']);
      expect(getKeybindings().getKeys('tui.altScreen.searchPrevious')).toEqual([
        'shift+enter',
        'ctrl+shift+g',
      ]);
      expect(getKeybindings().getKeys('tui.altScreen.searchNext')).toEqual(['enter', 'ctrl+g']);
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
});
