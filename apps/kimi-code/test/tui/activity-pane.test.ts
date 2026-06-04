import { describe, expect, it, vi } from 'vitest';

import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import type { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';

interface ActivityDriver {
  state: TUIState;
  sessionEventHandler: SessionEventHandler;
  updateActivityPane(): void;
}

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
    resolvedTheme: 'dark',
  };
}

function makeDriverWithTerminalProgress(): {
  driver: ActivityDriver;
  state: TUIState;
  setProgress: ReturnType<typeof vi.fn<(active: boolean) => void>>;
} {
  const setProgress = vi.fn<(active: boolean) => void>();
  const driver = new KimiTUI({} as never, makeStartupInput()) as unknown as ActivityDriver;
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  driver.state.terminal = { columns: 80, setProgress } as unknown as TUIState['terminal'];
  return { driver, state: driver.state, setProgress };
}

describe('updateActivityPane terminal progress', () => {
  it('toggles terminal progress when the activity pane enters and leaves work mode', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();

      state.livePane = { ...state.livePane, mode: 'waiting' };
      driver.updateActivityPane();

      expect(setProgress).toHaveBeenCalledTimes(1);
      expect(setProgress).toHaveBeenLastCalledWith(true);
      expect(state.terminalState.progressActive).toBe(true);

      state.livePane = { ...state.livePane, mode: 'idle' };
      driver.updateActivityPane();

      expect(setProgress).toHaveBeenCalledTimes(2);
      expect(setProgress).toHaveBeenLastCalledWith(false);
      expect(state.terminalState.progressActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps compaction visible as terminal progress even though the pane is hidden', () => {
    const { driver, state, setProgress } = makeDriverWithTerminalProgress();
    state.appState.isCompacting = true;
    state.appState.streamingPhase = 'waiting';

    driver.updateActivityPane();
    driver.updateActivityPane();

    expect(setProgress).toHaveBeenCalledTimes(1);
    expect(setProgress).toHaveBeenLastCalledWith(true);

    state.appState.isCompacting = false;
    state.appState.streamingPhase = 'idle';
    driver.updateActivityPane();

    expect(setProgress).toHaveBeenCalledTimes(2);
    expect(setProgress).toHaveBeenLastCalledWith(false);
  });

  it('keeps terminal progress active without showing a thinking spinner', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();
      state.livePane = { ...state.livePane, mode: 'idle' };
      state.appState.streamingPhase = 'thinking';

      driver.updateActivityPane();

      expect(setProgress).toHaveBeenCalledTimes(1);
      expect(setProgress).toHaveBeenLastCalledWith(true);
      expect(state.activitySpinner).toBeNull();
      expect(state.activityContainer.children).toHaveLength(0);

      state.appState.streamingPhase = 'idle';
      driver.updateActivityPane();

      expect(setProgress).toHaveBeenCalledTimes(2);
      expect(setProgress).toHaveBeenLastCalledWith(false);
      expect(state.activitySpinner).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the moon spinner into the AgentSwarm progress row while active', () => {
    vi.useFakeTimers();
    try {
      const { driver, state, setProgress } = makeDriverWithTerminalProgress();
      const progress = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: state.theme.colors,
      });
      progress.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      progress.markInputComplete();
      progress.markStarted('agent-1');
      driver.sessionEventHandler.agentSwarmProgress.set('call_swarm', progress);
      state.livePane = { ...state.livePane, mode: 'tool' };

      driver.updateActivityPane();

      expect(setProgress).toHaveBeenCalledTimes(1);
      expect(setProgress).toHaveBeenLastCalledWith(true);
      expect(state.activitySpinner).not.toBeNull();
      expect(state.activityContainer.children).toHaveLength(0);
      expect(strip(progress.render(80).join('\n'))).toContain('🌑 Working...');

      state.activitySpinner?.instance.stop();
      progress.dispose();
      driver.sessionEventHandler.agentSwarmProgress.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ended AgentSwarm progress on a placeholder instead of the moon spinner', () => {
    vi.useFakeTimers();
    try {
      const { driver, state } = makeDriverWithTerminalProgress();
      const progress = new AgentSwarmProgressComponent({
        description: 'Review changed files',
        colors: state.theme.colors,
      });
      progress.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
      progress.markInputComplete();
      progress.markStarted('agent-1');
      progress.markToolCallEnded();
      driver.sessionEventHandler.agentSwarmProgress.set('call_swarm', progress);
      state.livePane = { ...state.livePane, mode: 'tool' };

      driver.updateActivityPane();

      expect(state.activitySpinner).not.toBeNull();
      expect(state.activityContainer.children).toHaveLength(1);
      const output = strip(progress.render(80).join('\n'));
      expect(output).toContain('  Working...');
      expect(output).not.toContain('🌑 Working...');

      state.activitySpinner?.instance.stop();
      progress.dispose();
      driver.sessionEventHandler.agentSwarmProgress.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
