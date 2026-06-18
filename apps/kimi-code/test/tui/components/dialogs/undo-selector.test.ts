import { afterEach, describe, expect, it, vi } from 'vitest';

import { UndoSelectorComponent } from '#/tui/components/dialogs/undo-selector';
import { i18n } from '#/tui/i18n';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function selector(): UndoSelectorComponent {
  return new UndoSelectorComponent({
    choices: [{ id: 'a', count: 1, input: 'do thing', label: 'do thing' }],
    onSelect: vi.fn(),
    onCancel: vi.fn(),
  });
}

function text(component: UndoSelectorComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

describe('UndoSelectorComponent — locale rendering', () => {
  afterEach(() => {
    i18n.setLocale('en');
  });

  it('renders the shared navigate/select/cancel hints in Chinese under zh-CN', () => {
    i18n.setLocale('zh-CN');

    const out = text(selector());

    expect(out).toContain('↑↓ 导航');
    expect(out).toContain('Enter 选择');
    expect(out).toContain('Esc 取消');
    expect(out).not.toContain('navigate');
    expect(out).not.toContain('select');
    expect(out).not.toContain('cancel');
  });

  it('keeps the shared hints in English on the default locale', () => {
    const out = text(selector());

    expect(out).toContain('↑↓ navigate');
    expect(out).toContain('Enter select');
    expect(out).toContain('Esc cancel');
  });
});
