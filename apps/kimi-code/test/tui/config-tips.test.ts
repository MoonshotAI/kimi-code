import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIPS_CONFIG,
  DEFAULT_TUI_CONFIG,
  STATUS_LINE_ITEMS,
  parseTuiConfig,
  renderTuiConfig,
} from '#/tui/config';

describe('TUI config [tips]', () => {
  it('defaults to append mode with no custom tips', () => {
    expect(DEFAULT_TUI_CONFIG.tips).toEqual(DEFAULT_TIPS_CONFIG);
    expect(parseTuiConfig('').tips).toEqual({ mode: 'append', custom: [] });
  });

  it('parses the [tips] section', () => {
    const config = parseTuiConfig(`
[tips]
mode = "replace"
custom = ["Accidental Virtue", "Quantum Truss"]
`);
    expect(config.tips).toEqual({ mode: 'replace', custom: ['Accidental Virtue', 'Quantum Truss'] });
  });

  it('renders live custom tips and round-trips them', () => {
    const config = parseTuiConfig(`
[tips]
mode = "replace"
custom = ["Accidental Virtue"]
`);
    const rendered = renderTuiConfig(config);
    expect(rendered).toContain('[tips]');
    expect(rendered).toContain('mode = "replace"');
    expect(rendered).toContain('"Accidental Virtue"');
    expect(parseTuiConfig(rendered).tips).toEqual(config.tips);
  });

  it('renders a commented-out guide when no custom tips are set', () => {
    const rendered = renderTuiConfig(parseTuiConfig(''));
    expect(rendered).toContain('# [tips]');
    expect(rendered).not.toContain('\n[tips]');
  });

  it('escapes special characters in custom tips', () => {
    const config = parseTuiConfig('');
    const tricky = { ...config, tips: { mode: 'append' as const, custom: ['say "hi" \\ done'] } };
    const reparsed = parseTuiConfig(renderTuiConfig(tricky));
    expect(reparsed.tips?.custom).toEqual(['say "hi" \\ done']);
  });
});

describe('status_line sessionId item', () => {
  it('sessionId is a known status-line item', () => {
    expect(STATUS_LINE_ITEMS).toContain('sessionId');
  });

  it('parses sessionId in status_line.items', () => {
    const config = parseTuiConfig(`
[status_line]
items = ["model", "sessionId", "tips"]
`);
    expect(config.statusLine?.items).toEqual(['model', 'sessionId', 'tips']);
  });
});
