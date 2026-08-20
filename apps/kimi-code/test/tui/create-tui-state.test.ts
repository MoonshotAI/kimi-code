
import { describe, it, expect, vi } from 'vitest';

import { TuiAltScreen, TuiMainScreen } from '@moonshot-ai/pi-tui';

import { createTUIState, type KimiTUIOptions } from '#/tui/kimi-tui';
import type { AppState } from '#/tui/types';

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

    // UI objects are created.
    expect(state.ui).toBeDefined();
    expect(state.terminal).toBeDefined();
    expect(state.transcriptContainer).toBeDefined();
    expect(state.activityContainer).toBeDefined();
    expect(state.todoPanelContainer).toBeDefined();
    expect(state.queueContainer).toBeDefined();
    expect(state.editorContainer).toBeDefined();
    expect(state.editor).toBeDefined();
    expect(state.footer).toBeDefined();
    expect(state.todoPanel).toBeDefined();
    expect(state.theme.palette).toBeDefined();

    // App state is cloned from initialAppState, not reused by reference.
    expect(state.appState).not.toBe(opts.initialAppState);
    expect(state.appState.model).toBe('test-model');
    expect(state.appState.additionalDirs).toEqual([]);
    expect(state.appState.sessionId).toBe('sess-1');
    expect(state.startupState).toBe('pending');

    // LivePane defaults.
    expect(state.livePane.mode).toBe('idle');
    expect(state.livePane.pendingApproval).toBeNull();
    expect(state.livePane.pendingQuestion).toBeNull();

    // Empty collections.
    expect(state.transcriptEntries).toHaveLength(0);
    expect(state.queuedMessages).toHaveLength(0);

    // Boolean, counter, and optional-field defaults.
    expect(state.toolOutputExpanded).toBe(false);
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

  it('builds an alternate-screen renderer with a docked layout in fullscreen mode', () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    const state = createTUIState({
      initialAppState: fakeInitialAppState(),
      startup: {
        continueLast: false,
        yolo: false,
        auto: false,
        plan: false,
      },
    });
    vi.unstubAllEnvs();

    expect(state.ui).toBeInstanceOf(TuiAltScreen);
    expect(state.ui.mode).toBe('fullscreen');

    // The chrome docks below the transcript ScrollView, in z-order.
    const dock = state.dockContainer;
    expect(dock).toBeDefined();
    expect(dock?.children).toEqual([
      state.activityContainer,
      state.todoPanelContainer,
      state.queueContainer,
      state.btwPanelContainer,
      state.editorContainer,
    ]);

    // The layout root is mounted and the root children list stays empty.
    expect((state.ui as TuiAltScreen).getLayoutRoot()).toBeDefined();
    expect(state.ui.children).toHaveLength(0);

    // Mouse capture replaces native terminal link activation / right-click
    // paste, so both must be routed through renderer callbacks.
    const internals = state.ui as unknown as {
      openUrl?: (url: string) => void;
      onRightClickPaste?: () => void;
    };
    expect(typeof internals.openUrl).toBe('function');
    expect(typeof internals.onRightClickPaste).toBe('function');
  });
});
