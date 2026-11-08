import { TuiAltScreen, type Terminal } from '@moonshot-ai/pi-tui';
import type { Session, TowerProjection } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { TowerPanelController, isTowerPanelVisible } from '#/tui/controllers/tower-panel';
import { createTUIState } from '#/tui/tui-state';
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
    transcript: { groupTools: 'auto', groupThinking: true },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    mcpServersSummary: null,
  };
}

function makeProjection(): TowerProjection {
  return {
    status: 'active',
    hasContent: true,
    base: 'main',
    missionCounts: {
      planned: 0,
      active: 1,
      completed: 0,
      blocked: 0,
      paused: 0,
      merged: 0,
      abandoned: 0,
    },
    workersLive: 1,
    reviewersLive: 0,
    rosterTotal: 1,
    openMissions: [],
    recentClosed: [],
    events: [],
    logOffset: 0,
  };
}

function fakeTerminal(columns: number): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: () => {},
    columns,
    rows: 30,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  };
}

function createFullscreenState(columns: number) {
  const state = createTUIState({
    initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' },
    startup: { continueLast: false, yolo: false, auto: false, plan: false },
  });
  (state.ui as unknown as { terminal: Terminal }).terminal = fakeTerminal(columns);
  vi.spyOn(state.ui, 'requestRender').mockImplementation(() => {});
  return state;
}

describe('isTowerPanelVisible', () => {
  const base = { fullscreen: true, towerMode: true, hasContent: true, columns: 120 };

  it('shows only when fullscreen, tower mode on, content exists and width is enough', () => {
    expect(isTowerPanelVisible(base)).toBe(true);
  });

  it.each([
    ['inline mode', { fullscreen: false }],
    ['tower mode off', { towerMode: false }],
    ['no content', { hasContent: false }],
    ['narrow terminal', { columns: 119 }],
  ])('stays hidden for %s', (_label, patch) => {
    expect(isTowerPanelVisible({ ...base, ...patch })).toBe(false);
  });
});

describe('TowerPanelController', () => {
  it('watches only while tower mode is on, and clears the pane when it stops', async () => {
    const state = createFullscreenState(140);
    const projection = makeProjection();
    let listener: ((value: TowerProjection) => void) | undefined;
    const unsubscribe = vi.fn();
    const watchTowerProjection = vi.fn(async (callback: (value: TowerProjection) => void) => {
      listener = callback;
      callback(projection);
      return unsubscribe;
    });
    const session = { id: 'sess-1', watchTowerProjection } as unknown as Session;
    const controller = new TowerPanelController({ state, session });
    await Promise.resolve();

    controller.sync();
    expect(watchTowerProjection).not.toHaveBeenCalled();

    state.appState.towerMode = true;
    controller.sync();
    await Promise.resolve();
    await Promise.resolve();

    expect(watchTowerProjection).toHaveBeenCalledTimes(1);
    expect(state.towerPanelVisible()).toBe(true);
    expect(state.towerPane.render(44)).not.toEqual([]);

    controller.sync();
    expect(watchTowerProjection).toHaveBeenCalledTimes(1);

    state.appState.towerMode = false;
    controller.sync();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(state.towerPanelVisible()).toBe(false);
    expect(state.towerPane.render(44)).toEqual([]);

    listener?.(projection);
    expect(state.towerPane.render(44)).toEqual([]);
  });
});
