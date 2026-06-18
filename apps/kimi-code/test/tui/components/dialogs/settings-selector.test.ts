import { describe, expect, it, vi } from 'vitest';

import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';

const ANSI_SGR = /\[[0-9;]*m/g;
const DOWN_ARROW = '[B';
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('SettingsSelectorComponent', () => {
  it('lists a Language entry', () => {
    const out = new SettingsSelectorComponent({ onSelect: vi.fn(), onCancel: vi.fn() })
      .render(120)
      .map(strip);

    expect(out.some((l) => l.includes('Language'))).toBe(true);
  });

  it('routes the Language entry to onSelect("language")', () => {
    const onSelect = vi.fn();
    const selector = new SettingsSelectorComponent({ onSelect, onCancel: vi.fn() });

    // Navigate the cursor down to the Language row, then select it.
    let lines = selector.render(120).map(strip);
    for (let i = 0; i < 12 && !cursorOnLanguage(lines); i++) {
      selector.handleInput(DOWN_ARROW);
      lines = selector.render(120).map(strip);
    }
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith('language');
  });
});

function cursorOnLanguage(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes('❯') && l.includes('Language'));
}
