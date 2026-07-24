import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_STATUSLINE_CONFIG,
  DEFAULT_TUI_CONFIG,
  INVALID_TUI_CONFIG_MESSAGE,
  loadTuiConfig,
  parseTuiConfig,
  saveTuiConfig,
  TuiConfigParseError,
} from '#/tui/config';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = join(tmpdir(), `kimi-tui-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  filePath = join(dir, 'tui.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TUI config', () => {
  it('creates the default config when the file does not exist', async () => {
    const result = await loadTuiConfig(filePath);

    expect(result).toEqual(DEFAULT_TUI_CONFIG);
    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('Client preferences for kimi-code.');
    expect(text).toContain('theme = "auto"');
    expect(text).toContain('command = ""');
    expect(text).toContain('[upgrade]');
    expect(text).toContain('auto_install = true');
    expect(text).toContain('[notifications]');
    expect(text).toContain('enabled = true');
    expect(text).toContain('notification_condition = "unfocused"');
    expect(text).toContain('[statusline]');
    expect(text).toContain('interval_ms = 2000');
  });

  it('parses valid TOML', () => {
    const config = parseTuiConfig(`
theme = "light"

[editor]
command = "code --wait"

[notifications]
enabled = false
notification_condition = "always"

[upgrade]
auto_install = false
`);

    expect(config).toEqual({
      theme: 'light',
      disablePasteBurst: false,
      editorCommand: 'code --wait',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: DEFAULT_STATUSLINE_CONFIG,
    });
  });

  it('parses disable_paste_burst', () => {
    const config = parseTuiConfig(`
theme = "dark"
disable_paste_burst = true
`);

    expect(config.disablePasteBurst).toBe(true);
  });

  it('normalizes an empty editor command to auto-detect', () => {
    const config = parseTuiConfig(`
[editor]
command = "   "
`);

    expect(config).toEqual({
      theme: 'auto',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: DEFAULT_STATUSLINE_CONFIG,
    });
  });

  it('falls back to default notifications when the section is omitted', () => {
    const config = parseTuiConfig(`theme = "dark"`);

    expect(config.notifications).toEqual({ enabled: true, condition: 'unfocused' });
    expect(config.upgrade).toEqual({ autoInstall: true });
  });

  it('throws TuiConfigParseError with fallback when parsing fails, leaving the file untouched', async () => {
    writeFileSync(filePath, '[[[', 'utf-8');

    const error = await loadTuiConfig(filePath).then(
      () => null,
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(TuiConfigParseError);
    expect((error as TuiConfigParseError).message).toBe(INVALID_TUI_CONFIG_MESSAGE);
    expect((error as TuiConfigParseError).fallback).toEqual(DEFAULT_TUI_CONFIG);
    expect(readFileSync(filePath, 'utf-8')).toBe('[[[');
  });

  it('saves and reloads the normalized config', async () => {
    await saveTuiConfig(
      {
        theme: 'light',
        disablePasteBurst: false,
        editorCommand: 'vim',
        notifications: { enabled: false, condition: 'always' },
        upgrade: { autoInstall: false },
        statusLine: { command: '/tmp/statusline.sh', intervalMs: 1_000, timeoutMs: 3_000 },
      },
      filePath,
    );

    expect(await loadTuiConfig(filePath)).toEqual({
      theme: 'light',
      disablePasteBurst: false,
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { command: '/tmp/statusline.sh', intervalMs: 1_000, timeoutMs: 3_000 },
    });
  });

  it('escapes special characters in a custom theme name so the TOML round-trips', async () => {
    const theme = 'weird"name\\with-quote';
    await saveTuiConfig(
      {
        theme,
        disablePasteBurst: DEFAULT_TUI_CONFIG.disablePasteBurst,
        editorCommand: null,
        notifications: DEFAULT_TUI_CONFIG.notifications,
        upgrade: DEFAULT_TUI_CONFIG.upgrade,
        statusLine: DEFAULT_TUI_CONFIG.statusLine,
      },
      filePath,
    );

    expect((await loadTuiConfig(filePath)).theme).toBe(theme);
  });

  it('parses the [statusline] section', () => {
    const config = parseTuiConfig(`
[statusline]
command = "/path/to/statusline.sh"
interval_ms = 1500
timeout_ms = 8000
`);

    expect(config.statusLine).toEqual({
      command: '/path/to/statusline.sh',
      intervalMs: 1500,
      timeoutMs: 8000,
    });
  });

  it('defaults to a disabled statusline when the section is omitted', () => {
    const config = parseTuiConfig(`theme = "dark"`);

    expect(config.statusLine).toEqual(DEFAULT_STATUSLINE_CONFIG);
    expect(config.statusLine.command).toBeNull();
  });

  it('normalizes an empty statusline command to disabled', () => {
    const config = parseTuiConfig(`
[statusline]
command = "   "
`);

    expect(config.statusLine.command).toBeNull();
  });

  it('clamps a too-small statusline interval instead of rejecting the config', () => {
    const config = parseTuiConfig(`
[statusline]
command = "x"
interval_ms = 50
`);

    expect(config.statusLine.intervalMs).toBe(300);
  });

  it('round-trips the [statusline] section through save and load', async () => {
    await saveTuiConfig(
      {
        ...DEFAULT_TUI_CONFIG,
        statusLine: { command: 'echo hi', intervalMs: 2_500, timeoutMs: 4_000 },
      },
      filePath,
    );

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('[statusline]');
    expect(text).toContain('interval_ms = 2500');
    expect((await loadTuiConfig(filePath)).statusLine).toEqual({
      command: 'echo hi',
      intervalMs: 2_500,
      timeoutMs: 4_000,
    });
  });
});
