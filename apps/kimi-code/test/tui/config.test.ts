import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '');
  dir = join(tmpdir(), `kimi-tui-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  filePath = join(dir, 'tui.toml');
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(text).toContain('disable_feedback_survey = false');
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
      tuiMode: 'regular',
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      disableFeedbackSurvey: false,
      editorCommand: 'code --wait',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
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

  it('defaults disable_feedback_survey to false and parses true', () => {
    expect(parseTuiConfig('').disableFeedbackSurvey).toBe(false);

    const config = parseTuiConfig(`
disable_feedback_survey = true
`);

    expect(config.disableFeedbackSurvey).toBe(true);
  });

  it('normalizes an empty editor command to auto-detect', () => {
    const config = parseTuiConfig(`
[editor]
command = "   "
`);

    expect(config).toEqual({
      theme: 'auto',
      tuiMode: 'regular',
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      disableFeedbackSurvey: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
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
      tuiMode: 'regular',
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      disableFeedbackSurvey: false,
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
    });
  });

  it('round-trips a disable_feedback_survey opt-out', async () => {
    await saveTuiConfig(
      { ...DEFAULT_TUI_CONFIG, disableFeedbackSurvey: true },
      filePath,
    );

    expect(readFileSync(filePath, 'utf-8')).toContain('disable_feedback_survey = true');
    expect((await loadTuiConfig(filePath)).disableFeedbackSurvey).toBe(true);
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

describe('TUI config markdown', () => {
  it('defaults mermaid to final when the section is omitted', () => {
    expect(parseTuiConfig(`theme = "dark"`).markdown).toEqual({ mermaid: 'final' });
  });

  it('parses mermaid = "off"', () => {
    const config = parseTuiConfig(`
[markdown]
mermaid = "off"
`);

    expect(config.markdown).toEqual({ mermaid: 'off' });
  });

  it('warns and falls back to final for unknown mermaid values without failing the file', () => {
    const warnings: string[] = [];
    for (const value of ['stream', 'streaming']) {
      warnings.length = 0;
      const config = parseTuiConfig(
        `
theme = "dark"

[markdown]
mermaid = "${value}"
`,
        (message) => warnings.push(message),
      );

      expect(config.markdown).toEqual({ mermaid: 'final' });
      expect(config.theme).toBe('dark');
      expect(warnings).toEqual([`[tui.toml] ignoring unknown markdown.mermaid value: ${value}`]);
    }
  });

  it('keeps the [markdown] section a commented guide by default', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('# [markdown]');
    expect(text).toContain('# mermaid = "final"');
    expect(text).not.toContain('\n[markdown]');
  });

  it('writes a live [markdown] section when mermaid is off and round-trips it', async () => {
    await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, markdown: { mermaid: 'off' } }, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\n[markdown]\n');
    expect(text).toContain('mermaid = "off"');
    expect((await loadTuiConfig(filePath)).markdown).toEqual({ mermaid: 'off' });
  });
});

describe('TUI config tui_mode', () => {
  it('defaults tui_mode to regular when omitted', () => {
    expect(parseTuiConfig(`theme = "dark"`).tuiMode).toBe('regular');
  });

  it('parses tui_mode = "fullscreen"', () => {
    const config = parseTuiConfig(`
tui_mode = "fullscreen"
`);

    expect(config.tuiMode).toBe('fullscreen');
  });

  it('warns and falls back to regular for unknown tui_mode values without failing the file', () => {
    const warnings: string[] = [];
    const config = parseTuiConfig(
      `
theme = "dark"
tui_mode = "weird"
`,
      (message) => warnings.push(message),
    );

    expect(config.tuiMode).toBe('regular');
    expect(config.theme).toBe('dark');
    expect(warnings).toEqual(['[tui.toml] ignoring unknown tui_mode value: weird']);
  });

  it('writes a live tui_mode key even at the default value', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\ntui_mode = "regular"');
    expect(text).not.toContain('# tui_mode');
  });

  it('writes a live tui_mode when fullscreen and round-trips it', async () => {
    await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, tuiMode: 'fullscreen' }, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\ntui_mode = "fullscreen"');
    expect((await loadTuiConfig(filePath)).tuiMode).toBe('fullscreen');
  });
});

describe('TUI config tui_mode env migration', () => {
  it('migrates KIMI_CODE_TUI_FULL_SCREEN=1 into tui_mode when the key is absent', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    writeFileSync(filePath, 'theme = "dark"\n', 'utf-8');
    const warnings: string[] = [];

    const config = await loadTuiConfig(filePath, (message) => warnings.push(message));

    expect(config.tuiMode).toBe('fullscreen');
    expect(readFileSync(filePath, 'utf-8')).toContain('\ntui_mode = "fullscreen"');
    expect(warnings).toEqual([]);
  });

  it('ignores the env when tui_mode is explicitly regular', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    writeFileSync(filePath, 'tui_mode = "regular"\n', 'utf-8');

    const config = await loadTuiConfig(filePath);

    expect(config.tuiMode).toBe('regular');
    expect(readFileSync(filePath, 'utf-8')).toBe('tui_mode = "regular"\n');
  });

  it('does not migrate over an explicitly set unknown value', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    writeFileSync(filePath, 'tui_mode = "weird"\n', 'utf-8');
    const warnings: string[] = [];

    const config = await loadTuiConfig(filePath, (message) => warnings.push(message));

    expect(config.tuiMode).toBe('regular');
    expect(warnings).toEqual(['[tui.toml] ignoring unknown tui_mode value: weird']);
    expect(readFileSync(filePath, 'utf-8')).toBe('tui_mode = "weird"\n');
  });

  it('only honors the exact value 1 like the old gate', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', 'true');
    writeFileSync(filePath, 'theme = "dark"\n', 'utf-8');

    const config = await loadTuiConfig(filePath);

    expect(config.tuiMode).toBe('regular');
    expect(readFileSync(filePath, 'utf-8')).toBe('theme = "dark"\n');
  });

  it('migrates when the config file does not exist yet', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');

    const config = await loadTuiConfig(filePath);

    expect(config.tuiMode).toBe('fullscreen');
    expect(readFileSync(filePath, 'utf-8')).toContain('\ntui_mode = "fullscreen"');
  });

  it('does not re-migrate after a regular preference has been saved', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, tuiMode: 'regular' }, filePath);

    const config = await loadTuiConfig(filePath);

    expect(config.tuiMode).toBe('regular');
    expect(readFileSync(filePath, 'utf-8')).toContain('\ntui_mode = "regular"');
  });
});
