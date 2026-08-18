import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_MAX_CAPTURE_BYTES,
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
  stepRetry: null,
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

  it('honors the configured position of the tips slot', () => {
    // The tip content itself rotates; locate it via a tips-only render.
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[0]!,
    ).trim();

    const tipsFirst = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips', 'model'], command: null },
      }).render(200)[0]!,
    );
    const tipsLast = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['model', 'tips'], command: null },
      }).render(200)[0]!,
    );

    expect(tipsOnly.length).toBeGreaterThan(0);
    expect(tipsFirst.indexOf(tipsOnly)).toBeLessThan(tipsFirst.indexOf('kimi-k2'));
    expect(tipsLast.indexOf('kimi-k2')).toBeLessThan(tipsLast.indexOf(tipsOnly));
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

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const line = await runStatusLineCommand(
      'head -c 200000 /dev/zero | tr "\\0" "a"',
      payload,
    );

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
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

  it('runs a deferred refresh after the throttle interval instead of dropping it', async () => {
    const dir = join(tmpdir(), `sl-trailing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const counterFile = join(dir, 'count');
      const scriptFile = join(dir, 'count.sh');
      writeFileSync(counterFile, '0');
      writeFileSync(
        scriptFile,
        '#!/bin/sh\nn=$(cat "$1")\necho $((n+1)) > "$1"\nprintf "run-%s" "$n"\n',
      );
      const runner = new StatusLineCommandRunner(`sh ${scriptFile} ${counterFile}`, () => {});

      runner.maybeRefresh(payload);
      await new Promise((resolve) => setTimeout(resolve, 250));
      runner.maybeRefresh(payload); // throttled: must defer, not drop
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('1');

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('2');
      runner.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'printf "aaa"' },
    };
    const footer = new FooterComponent(state);
    footer.render(120); // kicks the first run
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plain(footer.render(120)[0]!)).toContain('aaa');

    footer.setState({ ...state, statusLine: { items: null, command: 'printf "bbb"' } });
    footer.render(120); // kicks the replacement run
    await new Promise((resolve) => setTimeout(resolve, 450));

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('bbb');
    expect(line1).not.toContain('aaa');
  });
});
