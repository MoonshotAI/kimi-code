import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelSwitchConfirmDialogComponent } from '#/tui/components/dialogs/model-switch-confirm-dialog';
import { currentTheme } from '#/tui/theme';

const ANSI_SGR = /\[[0-9;]*m/g;
const DEFAULT_HINT = 'Switching models in this session may affect output quality.';

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderDialog(
  sessionType: 'old' | 'new' = 'old',
  hint: string | undefined = DEFAULT_HINT,
  warning?: string,
  width = 120,
) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new ModelSwitchConfirmDialogComponent({
    fromModel: 'Kimi K2.5',
    toModel: 'Kimi K2 Turbo',
    sessionType,
    hint,
    warning,
    onSelect,
    onCancel,
  });
  return { dialog, onSelect, onCancel, lines: dialog.render(width).map(strip) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelSwitchConfirmDialogComponent', () => {
  it('renders the title, model suffix, hint, and keyboard hint', () => {
    const { lines } = renderDialog();
    expect(lines.some((l) => l.includes('Switch model?') && l.includes('Kimi K2.5 → Kimi K2 Turbo'))).toBe(true);
    expect(lines.some((l) => l.includes(DEFAULT_HINT))).toBe(true);
    const titleIdx = lines.findIndex((l) => l.includes('Switch model'));
    expect(lines[titleIdx + 1]).toContain('↑↓ navigate');
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
  });

  it('renders only compact, continue, and cancel for an old session', () => {
    const { lines } = renderDialog('old');
    const compact = lines.findIndex((l) => l.includes('Compact and continue'));
    const asIs = lines.findIndex((l) => l.includes('Continue as-is'));
    const cancel = lines.findIndex((l) => l.includes('Cancel'));

    expect(compact).toBeGreaterThanOrEqual(0);
    expect(compact).toBeLessThan(asIs);
    expect(asIs).toBeLessThan(cancel);
    expect(lines.some((l) => l.includes('Start a new session'))).toBe(false);
    expect(lines[compact]).toContain('Lower cost and better output quality');
    expect(lines[asIs]).toContain('Output quality may suffer');
    expect(lines[cancel]).toContain('Stay on the current model');
  });

  it('renders only confirm and cancel for a new session', () => {
    const { lines } = renderDialog('new');
    const confirm = lines.findIndex((l) => l.includes('Confirm switch'));
    const cancel = lines.findIndex((l) => l.includes('Cancel'));

    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(confirm).toBeLessThan(cancel);
    expect(lines.some((l) => l.includes('Compact and continue'))).toBe(false);
    expect(lines.some((l) => l.includes('Start a new session'))).toBe(false);
  });

  it.each(['old', 'new'] as const)('renders the effort title and cloud texts for a %s session', (sessionType) => {
    const dialog = new ModelSwitchConfirmDialogComponent({
      fromModel: 'low',
      toModel: 'high',
      sessionType,
      kind: 'effort',
      hint: DEFAULT_HINT,
      warning: 'Effort warning',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = dialog.render(120).map(strip);

    expect(lines.some((line) => line.includes('Switch effort from low to high?'))).toBe(true);
    expect(lines.some((line) => line.includes('low → high'))).toBe(false);
    expect(lines.some((line) => line.includes(DEFAULT_HINT))).toBe(true);
    expect(lines.some((line) => line.includes('Effort warning'))).toBe(true);
    expect(lines.some((line) => line.includes('Compact and continue'))).toBe(false);
    expect(lines.some((line) => line.includes('Continue as-is'))).toBe(false);
    expect(lines.some((line) => line.includes('Confirm switch'))).toBe(true);
    expect(lines.some((line) => line.includes('Stay on the current effort'))).toBe(true);
  });

  it('aligns old-session description columns', () => {
    const { lines } = renderDialog('old');
    const colOf = (labelNeedle: string, descNeedle: string) => {
      const line = lines.find((l) => l.includes(labelNeedle));
      expect(line).toBeDefined();
      return line!.indexOf(descNeedle);
    };
    const reference = colOf('Compact and continue', 'Lower cost and better');
    expect(colOf('Continue as-is', 'Output quality may suffer')).toBe(reference);
  });

  it('selects compact by default in an old session', () => {
    const { dialog, onSelect } = renderDialog('old');
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('compact');
  });

  it('selects confirm by default in a new session', () => {
    const { dialog, onSelect } = renderDialog('new');
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('continue');
  });

  it('navigates before selecting', () => {
    const { dialog, onSelect } = renderDialog('old');
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('continue');
  });

  it('cancels on Esc without selecting', () => {
    const { dialog, onSelect, onCancel } = renderDialog();
    dialog.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders each line of a multi-line hint as its own row', () => {
    const { lines } = renderDialog('new', 'First line.\r\nSecond line.\nThird line.');
    expect(lines.some((l) => l.includes('First line.'))).toBe(true);
    expect(lines.some((l) => l.includes('Second line.'))).toBe(true);
    expect(lines.some((l) => l.includes('Third line.'))).toBe(true);
    expect(lines.some((l) => l.includes('\r') || l.includes('\n'))).toBe(false);
  });

  it('renders warning after hint with bold warning styling', () => {
    const warningStyle = vi.spyOn(currentTheme, 'boldFg');
    const { lines } = renderDialog('old', DEFAULT_HINT, 'Highspeed costs twice as much.');
    const hint = lines.findIndex((l) => l.includes(DEFAULT_HINT));
    const warning = lines.findIndex((l) => l.includes('Highspeed costs twice as much.'));
    const compact = lines.findIndex((l) => l.includes('Compact and continue'));

    expect(hint).toBeLessThan(warning);
    expect(warning).toBeLessThan(compact);
    expect(warningStyle).toHaveBeenCalledWith('warning', ' Highspeed costs twice as much.');
  });

  it('omits the body when neither hint nor warning is provided', () => {
    const dialog = new ModelSwitchConfirmDialogComponent({
      fromModel: 'Kimi K2.5',
      toModel: 'Kimi K2 Turbo',
      sessionType: 'new',
      hint: undefined,
      warning: undefined,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = dialog.render(120).map(strip);
    const titleIdx = lines.findIndex((l) => l.includes('Switch model'));
    const firstOptionIdx = lines.findIndex((l) => l.includes('Confirm switch'));
    expect(firstOptionIdx - titleIdx).toBe(3);
  });

  it('keeps Chinese hint and warning within narrow widths', () => {
    const { lines } = renderDialog(
      'old',
      '在已有会话中切换模型可能影响模型效果；请选择继续方式。',
      '注意：高速模型消耗量约为普通模型的两倍。',
      32,
    );
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
  });
});
