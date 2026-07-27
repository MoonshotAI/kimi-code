import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

const baseState: AppState = {
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
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

const payload: StatusLinePayload = {
  model: 'kimi-k2',
  cwd: '/tmp/project',
  gitBranch: 'main',
  permissionMode: 'manual',
  planMode: false,
  contextUsage: 12,
  contextTokens: 1024,
  maxContextTokens: 8192,
  sessionId: 'ses-1',
  version: '1.2.3',
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('FooterComponent status_line items', () => {
  it('renders only the chosen slots in the given order', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['cwd', 'model'], command: null },
    };
    const footer = new FooterComponent(state);

    const line1 = plain(footer.render(120)[0]!);
    const cwdAt = line1.indexOf('/tmp/project');
    const modelAt = line1.indexOf('kimi-k2');
    expect(cwdAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(cwdAt);
    expect(line1).not.toContain('goal');
  });

  it('keeps the default layout when statusLine is unset', () => {
    const footer = new FooterComponent({ ...baseState });

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('kimi-k2');
    expect(line1).toContain('/tmp/project');
  });

  it('drops the rotating tips when tips is not in items', () => {
    const withTips = plain(new FooterComponent(baseState).render(200)[0]!);
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd'], command: null },
    };
    const withoutTips = plain(new FooterComponent(state).render(200)[0]!);

    expect(withoutTips.length).toBeLessThan(withTips.length);
    expect(withoutTips.trimEnd()).toMatch(/kimi-k2 {2}\/tmp\/project$/);
  });

  it('renders nothing on line 1 for an empty items list', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: [], command: null },
    };
    const footer = new FooterComponent(state);

    expect(plain(footer.render(120)[0]!).trim()).toBe('');
  });
});

describe('runStatusLineCommand', () => {
  it('passes the payload as JSON on stdin and returns the first stdout line', async () => {
    const line = await runStatusLineCommand('cat', payload);

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  });

  it('returns null on a nonzero exit', async () => {
    expect(await runStatusLineCommand('exit 3', payload)).toBeNull();
  });

  it('returns null on empty output', async () => {
    expect(await runStatusLineCommand('true', payload)).toBeNull();
  });

  it('returns null when the command overruns the timeout', async () => {
    expect(await runStatusLineCommand('sleep 2', payload, 100)).toBeNull();
  });

  it('trims the line and ignores later lines', async () => {
    const line = await runStatusLineCommand('printf "first\\nsecond\\n"', payload);

    expect(line).toBe('first');
  });
});

describe('FooterComponent status_line command', () => {
  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'printf "my-custom-status"' },
    };
    const footer = new FooterComponent(state);

    // Before the first run completes the built-in layout is still shown.
    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
  });

  it('keeps the built-in layout when the command fails', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'exit 1' },
    };
    const footer = new FooterComponent(state);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const runner = new StatusLineCommandRunner('printf "x"', () => {});

    runner.maybeRefresh(payload);
    runner.maybeRefresh(payload);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.current()).toBe('x');
  });
});
