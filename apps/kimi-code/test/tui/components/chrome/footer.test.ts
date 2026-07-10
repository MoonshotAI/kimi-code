import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';

const statusLineMocks = vi.hoisted(() => ({
  runStatusLineCommand: vi.fn(),
}));

vi.mock('#/tui/utils/status-line-command', () => statusLineMocks);

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

// Dark dance colors the footer never uses outside of /dance.
const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  statusLine: { command: null, timeoutMs: 200 },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

describe('FooterComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
    statusLineMocks.runStatusLineCommand.mockReset();
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('thinking: high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });
});

describe('FooterComponent status line command', () => {
  it('falls back when older app state fixtures omit statusLine', () => {
    const { statusLine: _statusLine, ...legacyState } = appState;

    const footer = new FooterComponent(legacyState as AppState);

    expect(footer.render(120).join('\n')).toContain('context: 0.0%');
    footer.dispose();
  });

  it('uses the command output on the second line when configured', async () => {
    statusLineMocks.runStatusLineCommand.mockResolvedValue('model: kimi-k2 | dir: project');
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        statusLine: { command: 'kimi-hud', timeoutMs: 250 },
      },
      onRefresh,
    );

    await vi.waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });

    const rendered = footer.render(120).join('\n');
    expect(rendered).toContain('model: kimi-k2 | dir: project');
    expect(rendered).not.toContain('context: 0.0%');
    expect(statusLineMocks.runStatusLineCommand).toHaveBeenCalledWith({
      command: 'kimi-hud',
      timeoutMs: 250,
      payload: expect.objectContaining({
        session_id: 'ses-1',
        model: 'kimi-k2',
        display_model: 'kimi-k2',
        cwd: '/tmp/project',
        permission_mode: 'manual',
      }),
    });

    footer.dispose();
  });

  it('does not refresh the external command on unrelated state updates', async () => {
    statusLineMocks.runStatusLineCommand.mockResolvedValue('model: kimi-k2 | dir: project');
    const footer = new FooterComponent({
      ...appState,
      statusLine: { command: 'kimi-hud', timeoutMs: 250 },
    });

    await vi.waitFor(() => {
      expect(statusLineMocks.runStatusLineCommand).toHaveBeenCalled();
    });
    statusLineMocks.runStatusLineCommand.mockClear();

    footer.setState({
      ...appState,
      contextUsage: 0.5,
      statusLine: { command: 'kimi-hud', timeoutMs: 250 },
    });

    expect(statusLineMocks.runStatusLineCommand).not.toHaveBeenCalled();
    footer.dispose();
  });

  it('falls back to the built-in context line when the command returns no output', async () => {
    statusLineMocks.runStatusLineCommand.mockResolvedValue(null);
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        statusLine: { command: 'kimi-hud', timeoutMs: 250 },
      },
      onRefresh,
    );

    await vi.waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });

    expect(footer.render(120).join('\n')).toContain('context: 0.0%');

    footer.dispose();
  });

  it('ignores stale command output after the status line is disabled', async () => {
    const first = deferred<string | null>();
    statusLineMocks.runStatusLineCommand.mockReturnValue(first.promise);
    const footer = new FooterComponent({
      ...appState,
      statusLine: { command: 'kimi-hud', timeoutMs: 250 },
    });

    footer.setState({ ...appState, statusLine: { command: null, timeoutMs: 250 } });
    first.resolve('stale hud');
    await first.promise;
    await Promise.resolve();

    const rendered = footer.render(120).join('\n');
    expect(rendered).toContain('context: 0.0%');
    expect(rendered).not.toContain('stale hud');

    footer.dispose();
  });

  it('ignores stale output after switching to another status line command', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    statusLineMocks.runStatusLineCommand.mockImplementation(
      ({ command }: { command: string }) =>
        command === 'kimi-hud-a' ? first.promise : second.promise,
    );
    const onRefresh = vi.fn();
    const footer = new FooterComponent(
      {
        ...appState,
        statusLine: { command: 'kimi-hud-a', timeoutMs: 250 },
      },
      onRefresh,
    );

    footer.setState({ ...appState, statusLine: { command: 'kimi-hud-b', timeoutMs: 250 } });
    first.resolve('old hud');
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    second.resolve('new hud');
    await second.promise;
    await Promise.resolve();
    await Promise.resolve();

    const rendered = footer.render(120).join('\n');
    expect(rendered).toContain('new hud');
    expect(rendered).not.toContain('old hud');

    footer.dispose();
  });
});
