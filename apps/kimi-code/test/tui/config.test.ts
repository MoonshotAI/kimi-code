import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FOOTER_CONFIG,
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
    expect(text).toContain('[footer]');
    expect(text).toContain('show_version = false');
    expect(text).toContain('show_plan_usage = false');
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
      footer: DEFAULT_FOOTER_CONFIG,
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
      footer: DEFAULT_FOOTER_CONFIG,
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
        footer: { showVersion: true, showPlanUsage: true, planUsageRefreshSeconds: 30 },
      },
      filePath,
    );

    expect(await loadTuiConfig(filePath)).toEqual({
      theme: 'light',
      disablePasteBurst: false,
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      footer: { showVersion: true, showPlanUsage: true, planUsageRefreshSeconds: 30 },
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
        footer: DEFAULT_TUI_CONFIG.footer,
      },
      filePath,
    );

    expect((await loadTuiConfig(filePath)).theme).toBe(theme);
  });

  it('parses the [footer] section', () => {
    const config = parseTuiConfig(`
[footer]
show_version = true
show_plan_usage = true
plan_usage_refresh_seconds = 120
`);

    expect(config.footer).toEqual({
      showVersion: true,
      showPlanUsage: true,
      planUsageRefreshSeconds: 120,
    });
  });

  it('defaults both footer enrichments to off when the section is omitted', () => {
    const config = parseTuiConfig(`theme = "dark"`);

    expect(config.footer).toEqual(DEFAULT_FOOTER_CONFIG);
    expect(config.footer.showVersion).toBe(false);
    expect(config.footer.showPlanUsage).toBe(false);
  });

  it('clamps a non-positive footer refresh period instead of rejecting the config', () => {
    const config = parseTuiConfig(`
[footer]
plan_usage_refresh_seconds = 0
`);

    expect(config.footer.planUsageRefreshSeconds).toBe(1);
  });

  it('round-trips the [footer] section through save and load', async () => {
    await saveTuiConfig(
      {
        ...DEFAULT_TUI_CONFIG,
        footer: { showVersion: true, showPlanUsage: true, planUsageRefreshSeconds: 90 },
      },
      filePath,
    );

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('[footer]');
    expect(text).toContain('show_version = true');
    expect(text).toContain('plan_usage_refresh_seconds = 90');
    expect((await loadTuiConfig(filePath)).footer).toEqual({
      showVersion: true,
      showPlanUsage: true,
      planUsageRefreshSeconds: 90,
    });
  });
});
