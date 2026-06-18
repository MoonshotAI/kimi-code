import { describe, expect, it, vi } from 'vitest';

import { LanguageSelectorComponent } from '#/tui/components/dialogs/language-selector';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('LanguageSelectorComponent', () => {
  it('renders Auto / English / 简体中文 with the current value highlighted', () => {
    const selector = new LanguageSelectorComponent({
      currentValue: 'zh-CN',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = selector.render(120).map(strip);

    expect(out.some((l) => l.includes('Auto'))).toBe(true);
    expect(out.some((l) => l.includes('English'))).toBe(true);
    expect(out).toContain('  ❯ 简体中文 ← current');
  });

  it('fires onSelect with the chosen language value on Enter', () => {
    const onSelect = vi.fn();
    const selector = new LanguageSelectorComponent({
      currentValue: 'auto',
      onSelect,
      onCancel: vi.fn(),
    });

    // Cursor starts on the current value ('auto', the first option). Enter selects it.
    selector.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith('auto');
  });
});
