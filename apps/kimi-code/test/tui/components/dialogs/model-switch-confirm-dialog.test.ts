import { describe, expect, it, vi } from 'vitest';

import { ModelSwitchConfirmDialogComponent } from '#/tui/components/dialogs/model-switch-confirm-dialog';

const ANSI_SGR = /\[[0-9;]*m/g;

const DEFAULT_HINT =
  'The prompt cache changes on a model switch — token usage may increase and model behavior may be inconsistent.';

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderDialog(fromModel = 'Kimi K2.5', toModel = 'Kimi K2 Turbo', hint: string | undefined = DEFAULT_HINT) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new ModelSwitchConfirmDialogComponent({ fromModel, toModel, hint, onSelect, onCancel });
  return { dialog, onSelect, onCancel, lines: dialog.render(120).map(strip) };
}

describe('ModelSwitchConfirmDialogComponent', () => {
  it('renders the hardcoded title with the from/to model suffix', () => {
    const { lines } = renderDialog();
    expect(lines.some((l) => l.includes('Switch model?') && l.includes('Kimi K2.5 → Kimi K2 Turbo'))).toBe(
      true,
    );
  });

  it('renders the default hint and the standard keyboard hint vocabulary', () => {
    const { lines } = renderDialog();
    expect(
      lines.some((l) =>
        l.includes(
          'The prompt cache changes on a model switch — token usage may increase and model behavior may be inconsistent.',
        ),
      ),
    ).toBe(true);
    const titleIdx = lines.findIndex((l) => l.includes('Switch model'));
    expect(lines[titleIdx + 1]).toContain('↑↓ navigate');
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
  });

  it('renders all four options in order with right-column descriptions', () => {
    const { lines } = renderDialog();
    const fresh = lines.findIndex((l) => l.includes('Start a new session'));
    const compact = lines.findIndex((l) => l.includes('Compact and continue'));
    const asIs = lines.findIndex((l) => l.includes('Continue as-is'));
    const cancel = lines.findIndex((l) => l.includes('Cancel'));

    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeLessThan(compact);
    expect(compact).toBeLessThan(asIs);
    expect(asIs).toBeLessThan(cancel);
    expect(lines[fresh]).toContain('No extra cost · best for a new task');
    expect(lines[compact]).toContain('Lower cost and better output quality when continuing this session');
    expect(lines[asIs]).toContain('Output quality may suffer · cache loss may increase token usage');
    expect(lines[cancel]).toContain('Stay on the current model');
  });

  it('aligns description columns across options', () => {
    const { lines } = renderDialog();
    const colOf = (labelNeedle: string, descNeedle: string) => {
      const line = lines.find((l) => l.includes(labelNeedle));
      expect(line).toBeDefined();
      return line!.indexOf(descNeedle);
    };
    const reference = colOf('Start a new session', 'No extra cost');
    expect(colOf('Compact and continue', 'Lower cost and better')).toBe(reference);
    expect(colOf('Continue as-is', 'Output quality may suffer')).toBe(reference);
  });

  it('selects the highlighted option on Enter, new session by default', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('new');
  });

  it('navigates with arrows before selecting', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\u001B[B'); // down
    dialog.handleInput('\u001B[B'); // down
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('continue');
  });

  it('cancels on Esc without selecting', () => {
    const { dialog, onSelect, onCancel } = renderDialog();
    dialog.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders a remote hint verbatim under the hardcoded title', () => {
    const { lines } = renderDialog('AAA', 'BBB', 'Remote hint text.');
    expect(lines.some((l) => l.includes('Switch model?') && l.includes('AAA → BBB'))).toBe(true);
    expect(lines.some((l) => l.includes('Remote hint text.'))).toBe(true);
    for (const label of ['Start a new session', 'Compact and continue', 'Continue as-is', 'Cancel']) {
      expect(lines.some((l) => l.includes(label))).toBe(true);
    }
  });

  it('renders each line of a multi-line hint as its own row', () => {
    const { lines } = renderDialog('AAA', 'BBB', 'First line.\r\nSecond line.\nThird line.');
    expect(lines.some((l) => l.includes('First line.'))).toBe(true);
    expect(lines.some((l) => l.includes('Second line.'))).toBe(true);
    expect(lines.some((l) => l.includes('Third line.'))).toBe(true);
    expect(lines.some((l) => l.includes('\r') || l.includes('\n'))).toBe(false);
  });

  it('renders a Chinese hint, truncating within narrow widths', () => {
    const { lines } = renderDialog(
      'Kimi K2.5',
      'Kimi K2 Turbo',
      '由于缓存发生变化，可能出现模型消耗增大或模型效果异常的情况。',
    );
    expect(lines.some((l) => l.includes('Switch model?') && l.includes('Kimi K2.5 → Kimi K2 Turbo'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('由于缓存发生变化，可能出现模型消耗增大或模型效果异常的情况。'))).toBe(
      true,
    );
  });

  it('omits the body line when no hint is provided', () => {
    const dialog = new ModelSwitchConfirmDialogComponent({
      fromModel: 'Kimi K2.5',
      toModel: 'Kimi K2 Turbo',
      hint: undefined,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = dialog.render(120).map(strip);
    expect(lines.some((l) => l.includes('Switch model?'))).toBe(true);
    expect(lines.some((l) => l.includes('Start a new session'))).toBe(true);
    const titleIdx = lines.findIndex((l) => l.includes('Switch model'));
    const firstOptionIdx = lines.findIndex((l) => l.includes('Start a new session'));
    expect(firstOptionIdx - titleIdx).toBe(3);
  });
});
