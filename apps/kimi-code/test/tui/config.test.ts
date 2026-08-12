import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
    expect(text).toContain('cache_expiry_hint = true');
    expect(text).toContain('command = ""');
    expect(text).toContain('[upgrade]');
    expect(text).toContain('auto_install = true');
    expect(text).toContain('[notifications]');
    expect(text).toContain('enabled = true');
    expect(text).toContain('notification_condition = "unfocused"');
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
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      editorCommand: 'code --wait',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
    });
  });

  it('parses disable_paste_burst', () => {
    const config = parseTuiConfig(`
theme = "dark"
disable_paste_burst = true
`);

    expect(config.disablePasteBurst).toBe(true);
  });

  it('defaults render_latex to true and parses false', () => {
    expect(parseTuiConfig('').renderLatex).toBe(true);

    const config = parseTuiConfig(`
render_latex = false
`);

    expect(config.renderLatex).toBe(false);
  });

  it('parses cache_expiry_hint', () => {
    const config = parseTuiConfig(`
theme = "dark"
cache_expiry_hint = false
`);

    expect(config.cacheExpiryHint).toBe(false);
  });

  it('normalizes an empty editor command to auto-detect', () => {
    const config = parseTuiConfig(`
[editor]
command = "   "
`);

    expect(config).toEqual({
      theme: 'auto',
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
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
        cacheExpiryHint: true,
        editorCommand: 'vim',
        notifications: { enabled: false, condition: 'always' },
        upgrade: { autoInstall: false },
        statusLine: { items: null, command: null },
      },
      filePath,
    );

    expect(await loadTuiConfig(filePath)).toEqual({
      theme: 'light',
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
    });
  });

  it('escapes special characters in a custom theme name so the TOML round-trips', async () => {
    const theme = 'weird"name\\with-quote';
    await saveTuiConfig(
      {
        theme,
        disablePasteBurst: DEFAULT_TUI_CONFIG.disablePasteBurst,
        cacheExpiryHint: DEFAULT_TUI_CONFIG.cacheExpiryHint,
        editorCommand: null,
        notifications: DEFAULT_TUI_CONFIG.notifications,
        upgrade: DEFAULT_TUI_CONFIG.upgrade,
        statusLine: DEFAULT_TUI_CONFIG.statusLine,
      },
      filePath,
    );

    expect((await loadTuiConfig(filePath)).theme).toBe(theme);
  });
});

describe('TUI config status_line', () => {
  it('defaults to null when the section is omitted', () => {
    const config = parseTuiConfig(`theme = "dark"`);

    expect(config.statusLine).toEqual({ items: null, command: null });
  });

  it('parses items and command', () => {
    const config = parseTuiConfig(`
[status_line]
items = ["model", "git", "cwd"]
command = "~/.kimi-code/statusline.sh"
`);

    expect(config.statusLine).toEqual({
      items: ['model', 'git', 'cwd'],
      command: '~/.kimi-code/statusline.sh',
    });
  });

  it('skips unknown items with a warning instead of failing the whole file', () => {
    const config = parseTuiConfig(`
[status_line]
items = ["model", "wat", "git"]
`);

    expect(config.statusLine?.items).toEqual(['model', 'git']);
  });

  it('routes unknown-item warnings through the provided callback instead of stderr', () => {
    const warnings: string[] = [];
    const config = parseTuiConfig(
      `
[status_line]
items = ["model", "wat", "git"]
`,
      (message) => warnings.push(message),
    );

    expect(config.statusLine?.items).toEqual(['model', 'git']);
    expect(warnings).toEqual(['[tui.toml] ignoring unknown status_line item: wat']);
  });

  it('normalizes an empty command to null', () => {
    const config = parseTuiConfig(`
[status_line]
command = "   "
`);

    expect(config.statusLine?.command).toBeNull();
  });

  it('documents status_line in the rendered template', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('[status_line]');
    expect(text).toContain('items');
    expect(text).toContain('command');
  });
});

describe('TUI config status_line round-trip', () => {
  it('preserves an active status_line across save and reload', async () => {
    await saveTuiConfig(
      {
        ...DEFAULT_TUI_CONFIG,
        statusLine: { items: ['model', 'git'], command: '~/.kimi-code/statusline.sh' },
      },
      filePath,
    );

    const reloaded = await loadTuiConfig(filePath);
    expect(reloaded.statusLine).toEqual({
      items: ['model', 'git'],
      command: '~/.kimi-code/statusline.sh',
    });
  });

  it('keeps the status_line section commented out when unset', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('# [status_line]');
    expect(text).toContain('# items =');
    expect(text).toContain('# command =');
  });
});
