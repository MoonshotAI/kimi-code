import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

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

  function pointerEvent(
    type: TuiMouseEvent['type'],
    y: number,
    wheelDelta?: number,
  ): TuiMouseEvent {
    return {
      type,
      button: type === 'move' || type === 'wheel' ? 'none' : 'left',
      x: 5,
      y,
      screenX: 5,
      screenY: y,
      width: 120,
      height: 20,
      shift: false,
      alt: false,
      ctrl: false,
      ...(wheelDelta !== undefined ? { wheelDelta } : {}),
    };
  }

  function enableFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  it('supports hover, click confirm, wheel consumption, and focus/settling guards', () => {
    enableFakeDate();
    const { dialog, onSelect, lines } = renderDialog();
    const newRow = lines.findIndex((line) => line.includes('Start a new session'));
    const neverRow = lines.findIndex((line) => line.includes("Don't ask me again"));

    vi.advanceTimersByTime(300);
    expect(dialog.handleMouse(pointerEvent('move', newRow))).toBeUndefined();
    expect(dialog.handleMouse(pointerEvent('wheel', newRow, 1))).toBeUndefined();
    expect(dialog.handleMouse(pointerEvent('press', newRow))).toEqual({ handled: true });
    expect(dialog.handleMouse(pointerEvent('click', newRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    dialog.focused = true;
    expect(dialog.handleMouse(pointerEvent('wheel', newRow, 1))).toEqual({ handled: true });
    expect(dialog.handleMouse(pointerEvent('move', newRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(dialog.render(120).map(strip)[newRow]).toContain('❯ Start a new session');

    dialog.handleMouse(pointerEvent('press', newRow));
    expect(dialog.handleMouse(pointerEvent('click', neverRow))).toEqual({ handled: true });
    expect(onSelect).not.toHaveBeenCalled();

    dialog.handleMouse(pointerEvent('press', neverRow));
    expect(dialog.handleMouse(pointerEvent('click', neverRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(onSelect).toHaveBeenCalledWith('never');

    const fresh = renderDialog();
    fresh.dialog.focused = true;
    const freshNewRow = fresh.lines.findIndex((line) => line.includes('Start a new session'));
    expect(fresh.dialog.handleMouse(pointerEvent('click', freshNewRow))).toEqual({
      handled: true,
    });
    expect(fresh.onSelect).not.toHaveBeenCalled();
  });
});
