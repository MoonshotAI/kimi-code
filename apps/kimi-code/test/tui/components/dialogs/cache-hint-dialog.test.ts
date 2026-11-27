import { TuiAltScreen } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { describe, expect, it, vi } from 'vitest';

import { CacheHintDialogComponent } from '#/tui/components/dialogs/cache-hint-dialog';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderDialog(idleSeconds = (26 * 24 + 22) * 3600, totalTokens = 293000) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new CacheHintDialogComponent({ idleSeconds, totalTokens, onSelect, onCancel });
  return { dialog, onSelect, onCancel, lines: dialog.render(120).map(strip) };
}

describe('CacheHintDialogComponent', () => {
  it('renders the title with idle duration and token count', () => {
    const { lines } = renderDialog();
    expect(
      lines.some((l) => l.includes('This session has been idle for 26d 22h and is ~286k tokens.')),
    ).toBe(true);
  });

  it('renders the body line and the standard hint vocabulary', () => {
    const { lines } = renderDialog();
    expect(
      lines.some((l) =>
        l.includes('Cache expired — the next message re-sends the entire history at full price.'),
      ),
    ).toBe(true);
    const titleIdx = lines.findIndex((l) => l.includes('This session has been idle'));
    expect(lines[titleIdx + 1]).toContain('↑↓ navigate');
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
  });

  it('renders all four options in order with right-column descriptions', () => {
    const { lines } = renderDialog();
    const compact = lines.findIndex((l) => l.includes('Compact and continue'));
    const fresh = lines.findIndex((l) => l.includes('Start a new session'));
    const asIs = lines.findIndex((l) => l.includes('Continue as-is'));
    const never = lines.findIndex((l) => l.includes("Don't ask me again"));

    expect(compact).toBeGreaterThanOrEqual(0);
    expect(compact).toBeLessThan(fresh);
    expect(fresh).toBeLessThan(asIs);
    expect(asIs).toBeLessThan(never);
    expect(lines[compact]).toContain('one-time compact cost · cheapest way to keep this topic');
    expect(lines[fresh]).toContain('zero context cost · best for a new task');
    expect(lines[asIs]).toContain('full history kept · highest cost per turn');
  });

  it('aligns description columns across options', () => {
    const { lines } = renderDialog();
    const colOf = (labelNeedle: string, descNeedle: string) => {
      const line = lines.find((l) => l.includes(labelNeedle));
      expect(line).toBeDefined();
      return line!.indexOf(descNeedle);
    };
    const reference = colOf('Compact and continue', 'one-time compact cost');
    expect(colOf('Start a new session', 'zero context cost')).toBe(reference);
    expect(colOf('Continue as-is', 'full history kept')).toBe(reference);
  });

  it('selects the highlighted option on Enter, compact by default', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('compact');
  });

  it('navigates with arrows before selecting', () => {
    const { dialog, onSelect } = renderDialog();
    dialog.handleInput('\u001B[B');
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

  it('guards unfocused first click, cancels dragged presses, and activates clicked option rows in fullscreen', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onSelect = vi.fn();
    const dialog = new CacheHintDialogComponent({
      idleSeconds: 7200,
      totalTokens: 120_000,
      onSelect,
      onCancel: vi.fn(),
    });
    const vt = new VirtualTerminal(100, 14);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(dialog);
    ui.start();
    await vt.waitForRender();
    try {
      const screen = vt.getViewport().map(strip);
      const newRow = screen.findIndex((line) => line.includes('Start a new session'));
      expect(newRow).toBeGreaterThan(0);

      now += 500;
      vt.sendInput(`\u001B[<0;10;${String(newRow + 1)}M`);
      vt.sendInput(`\u001B[<0;10;${String(newRow + 1)}m`);
      await vt.waitForRender();
      expect(dialog.focused).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();

      vt.sendInput(`\u001B[<35;10;${String(newRow + 1)}M`);
      await vt.waitForRender();
      expect(vt.getViewport().map(strip)[newRow]).toContain('❯ Start a new session');

      vt.sendInput(`\u001B[<0;10;${String(newRow + 1)}M`);
      vt.sendInput(`\u001B[<32;10;${String(newRow + 2)}M`);
      vt.sendInput(`\u001B[<0;10;${String(newRow + 2)}m`);
      await vt.waitForRender();
      expect(onSelect).not.toHaveBeenCalled();

      const descCol = screen[newRow]!.indexOf('zero context cost') + 2;
      vt.sendInput(`\u001B[<0;${String(descCol)};${String(newRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(descCol)};${String(newRow + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('new');
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });
});
