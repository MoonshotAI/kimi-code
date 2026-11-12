import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TUI_CONFIG,
  detectTuiModeFallback,
  INVALID_TUI_CONFIG_MESSAGE,
  loadTuiConfig,
  parseTuiConfig,
  renderTuiConfig,
  removeLegacySurveySetting,
  resolveAnimationFrameRate,
  resolveTuiMode,
  saveTuiConfig,
  TuiConfigParseError,
} from '#/tui/config';

let dir: string;
let filePath: string;

beforeEach(() => {
  vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '');
  vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
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
    expect(result.tuiMode).toBeUndefined();
    expect(result.followUpBehavior).toBeUndefined();
    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('Client preferences for kimi-code.');
    expect(text).toContain('theme = "auto"');
    expect(text).toContain('# tui_mode = "regular"');
    expect(text).not.toContain('\ntui_mode =');
    expect(text).toContain('\n# follow_up_behavior = "queue" # "queue" | "steer"');
    expect(text).not.toContain('\nfollow_up_behavior =');
    expect(text).toContain('cache_expiry_hint = true');
    expect(text).not.toContain('disable_feedback_survey');
    expect(text).toContain('auto_session_title = true');
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
      copyOnSelect: true,
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      autoSessionTitle: true,
      editorCommand: 'code --wait',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
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

  it('keeps a legacy disable_feedback_survey value only when the file sets it', () => {
    expect(parseTuiConfig('').disableFeedbackSurvey).toBeUndefined();

    const config = parseTuiConfig(`
disable_feedback_survey = true
`);

    expect(config.disableFeedbackSurvey).toBe(true);
  });

  it('defaults auto_session_title to true and parses false', () => {
    expect(parseTuiConfig('').autoSessionTitle).toBe(true);

    const config = parseTuiConfig(`
auto_session_title = false
`);

    expect(config.autoSessionTitle).toBe(false);
  });

  it('defaults copy_on_select to true and round-trips false through tui.toml', () => {
    expect(parseTuiConfig('').copyOnSelect).toBe(true);
    expect(renderTuiConfig(DEFAULT_TUI_CONFIG)).toContain('copy_on_select = true');

    const config = parseTuiConfig(`
copy_on_select = false
`);

    expect(config.copyOnSelect).toBe(false);
    expect(parseTuiConfig(renderTuiConfig(config)).copyOnSelect).toBe(false);
  });

  it('normalizes an empty editor command to auto-detect', () => {
    const config = parseTuiConfig(`
[editor]
command = "   "
`);

    expect(config).toEqual({
      theme: 'auto',
      copyOnSelect: true,
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      autoSessionTitle: true,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
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
        transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
        statusLine: { items: null, command: null },
      },
      filePath,
    );

    expect(await loadTuiConfig(filePath)).toEqual({
      theme: 'light',
      copyOnSelect: true,
      renderLatex: true,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      autoSessionTitle: true,
      editorCommand: 'vim',
      notifications: { enabled: false, condition: 'always' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
      markdown: { mermaid: 'final' },
      transcript: { toolCallDensity: 'compact', thinking: 'grouped' },
    });
  });

  it('preserves the legacy opt-out when an unrelated preference is saved', async () => {
    writeFileSync(filePath, 'disable_feedback_survey = true\nauto_session_title = false\n');
    const previous = await loadTuiConfig(filePath);
    await saveTuiConfig({ ...previous, disableFeedbackSurvey: undefined, theme: 'light' }, filePath);

    expect(await loadTuiConfig(filePath)).toMatchObject({
      theme: 'light', disableFeedbackSurvey: true, autoSessionTitle: false,
    });
  });

  it.each([
    { source: '[[[', legacy: undefined },
    { source: 'render_latex = "false"\ndisable_feedback_survey = true', legacy: true },
    { source: 'theme = 42\ndisable_feedback_survey = false', legacy: false },
    { source: 'disable_feedback_survey = "true"', legacy: undefined },
  ])('saves valid preferences after falling back from $source', async ({ source, legacy }) => {
    writeFileSync(filePath, source);
    await expect(loadTuiConfig(filePath)).rejects.toBeInstanceOf(TuiConfigParseError);
    await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, theme: 'light' }, filePath);
    const saved = await loadTuiConfig(filePath);
    expect(saved.theme).toBe('light');
    expect(saved.disableFeedbackSurvey).toBe(legacy);
  });

  it('removes only the migrated survey setting and can repeat the cleanup', async () => {
    writeFileSync(filePath, 'disable_feedback_survey = true\nauto_session_title = false\ntheme = "light"\n[custom]\nvalue = 42\n');
    await removeLegacySurveySetting(filePath);
    const cleaned = readFileSync(filePath, 'utf-8');
    expect(cleaned).not.toContain('disable_feedback_survey');
    expect(cleaned).toContain('value = 42');
    expect(await loadTuiConfig(filePath)).toMatchObject({ theme: 'light', autoSessionTitle: false });
    await removeLegacySurveySetting(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe(cleaned);
    await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, theme: 'dark' }, filePath);
    expect(readFileSync(filePath, 'utf-8')).not.toContain('disable_feedback_survey');
  });

  it('removes the survey setting line without disturbing comments or tables', async () => {
    writeFileSync(filePath, [
      '# ~/.kimi-code/tui.toml',
      '# Client preferences for kimi-code.',
      'theme = "dark" # "auto" | "dark" | "light"',
      '# my own note',
      'disable_feedback_survey = true',
      '# disable_feedback_survey = false',
      '',
      '[custom]',
      'disable_feedback_survey = true',
      'value = 42',
      '',
    ].join('\n'));

    await removeLegacySurveySetting(filePath);

    expect(readFileSync(filePath, 'utf-8')).toBe([
      '# ~/.kimi-code/tui.toml',
      '# Client preferences for kimi-code.',
      'theme = "dark" # "auto" | "dark" | "light"',
      '# my own note',
      '# disable_feedback_survey = false',
      '',
      '[custom]',
      'disable_feedback_survey = true',
      'value = 42',
      '',
    ].join('\n'));
  });

  it('removes a quoted spelling of the survey setting key', async () => {
    writeFileSync(filePath, '"disable_feedback_survey" = true\ntheme = "dark"\n');

    await removeLegacySurveySetting(filePath);

    expect(readFileSync(filePath, 'utf-8')).toBe('theme = "dark"\n');
  });

  it('round-trips an auto_session_title opt-out', async () => {
    await saveTuiConfig(
      { ...DEFAULT_TUI_CONFIG, autoSessionTitle: false },
      filePath,
    );

    expect(readFileSync(filePath, 'utf-8')).toContain('auto_session_title = false');
    expect((await loadTuiConfig(filePath)).autoSessionTitle).toBe(false);
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
        transcript: DEFAULT_TUI_CONFIG.transcript,
        statusLine: DEFAULT_TUI_CONFIG.statusLine,
      },
      filePath,
    );

    expect((await loadTuiConfig(filePath)).theme).toBe(theme);
  });
});

describe('TUI config transcript', () => {
  it('keeps the transcript section commented out at default values', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('# [transcript]');
    expect(text).toContain('# Fullscreen transcript display preferences.');
    expect(text.split('\n')).toContain('# tool_call_density = "compact" # "compact" | "balanced" | "detailed"');
    expect(text).toContain('# thinking = "grouped" # "grouped" | "ungrouped"');
    expect(text).not.toContain('\n[transcript]\n');
    expect(parseTuiConfig(text).transcript).toEqual(DEFAULT_TUI_CONFIG.transcript);
  });

  it('uses compact tool calls and grouped thinking when the section is omitted', () => {
    const warnings: string[] = [];
    expect(parseTuiConfig('', (message) => warnings.push(message)).transcript).toEqual({
      toolCallDensity: 'compact',
      thinking: 'grouped',
    });
    expect(parseTuiConfig('[transcript]\n', (message) => warnings.push(message)).transcript)
      .toEqual(DEFAULT_TUI_CONFIG.transcript);
    expect(warnings).toEqual([]);
  });

  it.each(['compact', 'balanced', 'detailed', 'ungrouped'] as const)(
    'parses tool_call_density = "%s" and keeps it through unrelated saves',
    async (toolCallDensity) => {
      const previous = parseTuiConfig(`[transcript]\ntool_call_density = "${toolCallDensity}"\nthinking = "ungrouped"\n`);
      expect(previous.transcript).toEqual({ toolCallDensity, thinking: 'ungrouped' });

      await saveTuiConfig({ ...previous, theme: 'light' }, filePath);

      expect(await loadTuiConfig(filePath)).toMatchObject({
        theme: 'light',
        transcript: { toolCallDensity, thinking: 'ungrouped' },
      });
      const text = readFileSync(filePath, 'utf-8');
      expect(text).toContain('\n[transcript]\n');
      expect(text).toContain(`tool_call_density = "${toolCallDensity}"`);
      expect(text).toContain('thinking = "ungrouped"');
    },
  );

  it('drops the old [transcript.group] table and unpublished flat keys without a warning', async () => {
    const warnings: string[] = [];
    const previous = parseTuiConfig(`
[transcript]
group_tools = "all"

[transcript.group]
tools = "explore"
group_thinking = false
`, (message) => warnings.push(message));

    expect(previous.transcript).toEqual(DEFAULT_TUI_CONFIG.transcript);
    expect(warnings).toEqual([]);

    await saveTuiConfig({ ...previous, theme: 'light' }, filePath);
    const text = readFileSync(filePath, 'utf-8');
    expect(text).not.toContain('transcript.group');
    expect(text).not.toContain('group_tools');
    expect(text).not.toContain('group_thinking');
  });

  it.each([
    ['tool_call_density = "sometimes"', 'tool_call_density', 'sometimes'],
    ['tool_call_density = "auto"', 'tool_call_density', 'auto'],
    ['thinking = "full"', 'thinking', 'full'],
    ['thinking = true', 'thinking', 'true'],
  ])('falls back for invalid %s and warns once', (setting, key, value) => {
    const warnings: string[] = [];
    const config = parseTuiConfig(`theme = "dark"\n\n[transcript]\n${setting}\n`, (message) => warnings.push(message));

    expect(config.theme).toBe('dark');
    expect(config.transcript).toEqual(DEFAULT_TUI_CONFIG.transcript);
    expect(warnings).toEqual([`[tui.toml] ignoring unknown transcript.${key} value: ${value}`]);
  });

  it('falls back only the invalid key and keeps the valid one', () => {
    const warnings: string[] = [];
    const density = parseTuiConfig('[transcript]\ntool_call_density = "balanced"\nthinking = 1\n', (message) => warnings.push(message));
    const thinking = parseTuiConfig('[transcript]\ntool_call_density = 2\nthinking = "ungrouped"\n', (message) => warnings.push(message));

    expect(density.transcript).toEqual({ toolCallDensity: 'balanced', thinking: 'grouped' });
    expect(thinking.transcript).toEqual({ toolCallDensity: 'compact', thinking: 'ungrouped' });
    expect(warnings).toEqual([
      '[tui.toml] ignoring unknown transcript.thinking value: 1',
      '[tui.toml] ignoring unknown transcript.tool_call_density value: 2',
    ]);
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

describe('TUI config follow_up_behavior', () => {
  it('leaves followUpBehavior undefined and commented across unrelated saves', async () => {
    const parsed = parseTuiConfig('theme = "dark"');
    expect(parsed.followUpBehavior).toBeUndefined();

    await saveTuiConfig({ ...parsed, theme: 'light', editorCommand: 'vim' }, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\n# follow_up_behavior = "queue" # "queue" | "steer"');
    expect(text).not.toContain('\nfollow_up_behavior =');
    expect((await loadTuiConfig(filePath)).followUpBehavior).toBeUndefined();
  });

  it.each(['queue', 'steer'] as const)('parses follow_up_behavior = "%s"', (followUpBehavior) => {
    expect(parseTuiConfig(`follow_up_behavior = "${followUpBehavior}"\n`).followUpBehavior)
      .toBe(followUpBehavior);
  });

  it.each([
    { setting: 'follow_up_behavior = "sometimes"', shown: 'sometimes' },
    { setting: 'follow_up_behavior = true', shown: 'true' },
    { setting: 'follow_up_behavior = 1', shown: '1' },
  ])('warns and leaves followUpBehavior undefined for $setting', ({ setting, shown }) => {
    const warnings: string[] = [];

    const config = parseTuiConfig(`${setting}\n`, (message) => warnings.push(message));

    expect(config.followUpBehavior).toBeUndefined();
    expect(warnings).toEqual([`[tui.toml] ignoring unknown follow_up_behavior value: ${shown}`]);
  });

  it.each(['queue', 'steer'] as const)(
    'writes an explicit %s preference and preserves it across unrelated saves',
    async (followUpBehavior) => {
      await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, followUpBehavior }, filePath);

      const line = `follow_up_behavior = "${followUpBehavior}" # "queue" | "steer"`;
      expect(readFileSync(filePath, 'utf-8')).toContain(`\n${line}`);
      const reloaded = await loadTuiConfig(filePath);
      expect(reloaded.followUpBehavior).toBe(followUpBehavior);

      await saveTuiConfig({ ...reloaded, theme: 'light' }, filePath);
      expect(readFileSync(filePath, 'utf-8')).toContain(`\n${line}`);
      expect((await loadTuiConfig(filePath)).followUpBehavior).toBe(followUpBehavior);
    },
  );
});

describe('TUI config tui_mode', () => {
  it('leaves tuiMode undefined when omitted so unrelated saves never persist regular', async () => {
    const parsed = parseTuiConfig(`theme = "dark"`);
    expect(parsed.tuiMode).toBeUndefined();

    await saveTuiConfig({ ...parsed, theme: 'light', editorCommand: 'vim' }, filePath);
    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\n# tui_mode = "regular"');
    expect(text).not.toContain('\ntui_mode =');
    expect((await loadTuiConfig(filePath)).tuiMode).toBeUndefined();
  });

  it('parses tui_mode = "fullscreen" and "regular"', () => {
    expect(parseTuiConfig('tui_mode = "fullscreen"\n').tuiMode).toBe('fullscreen');
    expect(parseTuiConfig('tui_mode = "regular"\n').tuiMode).toBe('regular');
  });

  it('warns and leaves tuiMode undefined for unknown tui_mode values without failing the file', () => {
    const warnings: string[] = [];
    const config = parseTuiConfig(
      `
theme = "dark"
tui_mode = "weird"
`,
      (message) => warnings.push(message),
    );

    expect(config.tuiMode).toBeUndefined();
    expect(config.theme).toBe('dark');
    expect(warnings).toEqual(['[tui.toml] ignoring unknown tui_mode value: weird']);
  });

  it('keeps tui_mode commented out at the default value', async () => {
    await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);

    const text = readFileSync(filePath, 'utf-8');
    expect(text).toContain('\n# tui_mode = "regular" # "regular" | "fullscreen" ("fullscreen" is experimental)');
    expect(text).not.toContain('\ntui_mode =');
  });

  it.each(['regular', 'fullscreen'] as const)(
    'writes a live tui_mode when explicitly set to %s and preserves it across unrelated saves',
    async (tuiMode) => {
      await saveTuiConfig({ ...DEFAULT_TUI_CONFIG, tuiMode }, filePath);

      const text = readFileSync(filePath, 'utf-8');
      expect(text).toContain(`\ntui_mode = "${tuiMode}"`);

      const reloaded = await loadTuiConfig(filePath);
      expect(reloaded.tuiMode).toBe(tuiMode);

      await saveTuiConfig({ ...reloaded, theme: 'light' }, filePath);
      expect(readFileSync(filePath, 'utf-8')).toContain(`\ntui_mode = "${tuiMode}"`);
    },
  );

  it('does not write tui_mode to disk when env flags are set', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');

    const created = await loadTuiConfig(filePath);
    expect(created.tuiMode).toBeUndefined();
    expect(readFileSync(filePath, 'utf-8')).toContain('\n# tui_mode = "regular"');
    expect(readFileSync(filePath, 'utf-8')).not.toContain('\ntui_mode =');

    writeFileSync(filePath, 'theme = "dark"\n', 'utf-8');
    const loaded = await loadTuiConfig(filePath);
    expect(loaded.tuiMode).toBeUndefined();
    expect(readFileSync(filePath, 'utf-8')).toBe('theme = "dark"\n');
  });
});

describe('resolveTuiMode', () => {
  const normalTermEnv = { TERM: 'xterm-256color' };

  it('defaults to regular when tui_mode is unset and experimental flag is off', () => {
    expect(resolveTuiMode(undefined, normalTermEnv)).toEqual({
      mode: 'regular',
      config: 'unset',
    });
    expect(
      resolveTuiMode(undefined, { ...normalTermEnv, KIMI_CODE_EXPERIMENTAL_FLAG: '0' }),
    ).toEqual({
      mode: 'regular',
      config: 'unset',
    });
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'defaults to fullscreen when tui_mode is unset and KIMI_CODE_EXPERIMENTAL_FLAG=%s',
    (flag) => {
      expect(
        resolveTuiMode(undefined, { ...normalTermEnv, KIMI_CODE_EXPERIMENTAL_FLAG: flag }),
      ).toEqual({
        mode: 'fullscreen',
        config: 'unset',
      });
    },
  );

  it('honors explicit regular or fullscreen in tui.toml over KIMI_CODE_EXPERIMENTAL_FLAG', () => {
    expect(
      resolveTuiMode('regular', { ...normalTermEnv, KIMI_CODE_EXPERIMENTAL_FLAG: '1' }),
    ).toEqual({
      mode: 'regular',
      config: 'regular',
    });
    expect(
      resolveTuiMode('fullscreen', { ...normalTermEnv, KIMI_CODE_EXPERIMENTAL_FLAG: '0' }),
    ).toEqual({
      mode: 'fullscreen',
      config: 'fullscreen',
    });
  });

  it('downgrades fullscreen to regular on iTerm2 tmux -CC, Termux, and dumb terminals', () => {
    const realTmuxCcEnv = {
      TMUX: '/tmp/tmux-501/default,123,0',
      TERM_PROGRAM: 'tmux',
      TERM: 'tmux-256color',
    };
    expect(detectTuiModeFallback(realTmuxCcEnv, () => true)).toBe('tmux_cc');
    expect(resolveTuiMode('fullscreen', realTmuxCcEnv, () => true)).toEqual({
      mode: 'regular',
      config: 'fullscreen',
      fallback: 'tmux_cc',
    });
    expect(
      resolveTuiMode(undefined, { ...realTmuxCcEnv, KIMI_CODE_EXPERIMENTAL_FLAG: '1' }, () => true),
    ).toEqual({
      mode: 'regular',
      config: 'unset',
      fallback: 'tmux_cc',
    });

    const fastPathTmuxCcEnv = {
      TMUX: '/tmp/tmux-501/default,123,0',
      TERM_PROGRAM: 'iTerm.app',
      TERM: 'xterm-256color',
    };
    const neverProbe = vi.fn(() => false);
    expect(detectTuiModeFallback(fastPathTmuxCcEnv, neverProbe)).toBe('tmux_cc');
    expect(neverProbe).not.toHaveBeenCalled();

    const termuxEnv = { TERM: 'xterm-256color', TERMUX_VERSION: '0.118.0' };
    expect(detectTuiModeFallback(termuxEnv)).toBe('termux');
    expect(resolveTuiMode('fullscreen', termuxEnv)).toEqual({
      mode: 'regular',
      config: 'fullscreen',
      fallback: 'termux',
    });

    const dumbEnv = { TERM: 'dumb' };
    expect(detectTuiModeFallback(dumbEnv)).toBe('dumb_term');
    expect(resolveTuiMode('fullscreen', dumbEnv)).toEqual({
      mode: 'regular',
      config: 'fullscreen',
      fallback: 'dumb_term',
    });
  });

  it('does not downgrade standard tmux sessions or report fallback when already regular', () => {
    const standardTmux = {
      TMUX: '/tmp/tmux-501/default,123,0',
      TERM_PROGRAM: 'tmux',
      LC_TERMINAL: 'iTerm2',
      TERM: 'tmux-256color',
    };
    expect(detectTuiModeFallback(standardTmux, () => false)).toBeUndefined();
    expect(resolveTuiMode('fullscreen', standardTmux, () => false)).toEqual({
      mode: 'fullscreen',
      config: 'fullscreen',
    });

    expect(resolveTuiMode('regular', { TERM: 'dumb' })).toEqual({
      mode: 'regular',
      config: 'regular',
    });
    expect(resolveTuiMode(undefined, { TERM: 'dumb' })).toEqual({
      mode: 'regular',
      config: 'unset',
    });
  });

  it('treats KIMI_CODE_TUI_FULL_SCREEN as highest-priority override bypassing fallback', () => {
    const tmuxCcEnv = {
      TMUX: '/tmp/tmux-501/default,123,0',
      TERM_PROGRAM: 'tmux',
      TERM: 'tmux-256color',
    };
    expect(
      resolveTuiMode('regular', { ...tmuxCcEnv, KIMI_CODE_TUI_FULL_SCREEN: '1' }, () => true),
    ).toEqual({
      mode: 'fullscreen',
      config: 'regular',
      overriddenByEnv: true,
    });
    expect(
      resolveTuiMode('fullscreen', { ...normalTermEnv, KIMI_CODE_TUI_FULL_SCREEN: '0' }),
    ).toEqual({
      mode: 'regular',
      config: 'fullscreen',
      overriddenByEnv: true,
    });
  });
});

describe('resolveAnimationFrameRate', () => {
  it.each([undefined, '', '   '])('keeps the default frame rate when KIMI_CODE_TUI_ANIMATION_FPS is %j', (value) => {
    expect(resolveAnimationFrameRate({ KIMI_CODE_TUI_ANIMATION_FPS: value })).toEqual({});
  });

  it.each([
    ['1', 1],
    ['8', 8],
    [' 30 ', 30],
    ['60', 60],
  ])('reads KIMI_CODE_TUI_ANIMATION_FPS=%j as %d frames per second', (value, fps) => {
    expect(resolveAnimationFrameRate({ KIMI_CODE_TUI_ANIMATION_FPS: value })).toEqual({ fps });
  });

  it.each(['abc', '0', '61', '-5', '2.5', '1e1', '0x10', '+8'])(
    'ignores KIMI_CODE_TUI_ANIMATION_FPS=%j and explains why',
    (value) => {
      expect(resolveAnimationFrameRate({ KIMI_CODE_TUI_ANIMATION_FPS: value })).toEqual({
        warning: `Ignored KIMI_CODE_TUI_ANIMATION_FPS="${value}": expected a whole number from 1 to 60.`,
      });
    },
  );

  it('reads process.env by default', () => {
    vi.stubEnv('KIMI_CODE_TUI_ANIMATION_FPS', '20');
    expect(resolveAnimationFrameRate()).toEqual({ fps: 20 });
  });
});
