import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function mouseEvent(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 120,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...(wheelDelta !== undefined ? { wheelDelta } : {}),
  };
}

function useFakeDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function text(component: EffortSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('EffortSelectorComponent', () => {
  it('renders efforts as horizontal segments with the active one bracketed', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    expect(out).toContain('Off');
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).toContain('Max');
    expect(out).toContain('[ High ]');
    expect(out).not.toContain('[ Off ]');
    expect(out).not.toContain('[ Max ]');
  });

  it('invokes onSelect with the chosen effort on Enter', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('high');
  });

  it('moves the active segment with Left/Right and stops at the edges', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');

    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');
  });

  it('invokes onSessionOnlySelect on Alt+S instead of onSelect', () => {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancels on Escape', () => {
    const onCancel = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
  });

  it('renders no warning line without the warning option', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe('');
  });

  it('updates the description as the highlighted effort changes', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'low',
      descriptions: {
        low: 'Light reasoning.',
        high: 'Deeper reasoning.',
        max: 'Maximum reasoning.',
      },
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(text(picker)).toContain('Light reasoning.');
    expect(text(picker)).not.toContain('Deeper reasoning.');
    picker.handleInput(RIGHT);
    expect(text(picker)).toContain('Deeper reasoning.');
    picker.handleInput(RIGHT);
    expect(text(picker)).toContain('Maximum reasoning.');
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    expect(text(picker)).not.toContain('Light reasoning.');
    expect(text(picker)).not.toContain('Deeper reasoning.');
    expect(text(picker)).not.toContain('Maximum reasoning.');
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(40).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });

  it('hovers segments, confirms on click, consumes wheel when focused, and guards unfocused/settling clicks', () => {
    useFakeDate();
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      descriptions: {
        low: 'Light reasoning.',
        high: 'Deeper reasoning.',
        max: 'Maximum reasoning.',
      },
      onSelect,
      onCancel: vi.fn(),
    });

    const lines = picker.render(120).map(strip);
    const barRow = lines.findIndex((line) => line.includes('[ High ]'));
    const lowCol = lines[barRow]!.indexOf('Low');
    const maxCol = lines[barRow]!.indexOf('Max');

    vi.advanceTimersByTime(300);
    expect(picker.handleMouse(mouseEvent('move', lowCol, barRow))).toBeUndefined();
    expect(picker.handleMouse(mouseEvent('wheel', lowCol, barRow, 1))).toBeUndefined();
    expect(picker.handleMouse(mouseEvent('press', lowCol, barRow))).toEqual({ handled: true });
    expect(picker.handleMouse(mouseEvent('click', lowCol, barRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(text(picker)).toContain('[ High ]');
    expect(onSelect).not.toHaveBeenCalled();

    picker.focused = true;
    expect(picker.handleMouse(mouseEvent('wheel', lowCol, barRow, 1))).toEqual({ handled: true });
    expect(picker.handleMouse(mouseEvent('move', lowCol, barRow))).toEqual({
      handled: true,
      render: true,
    });
    const afterHover = text(picker);
    expect(afterHover).toContain('[ Low ]');
    expect(afterHover).toContain('Light reasoning.');
    expect(onSelect).not.toHaveBeenCalled();

    picker.handleMouse(mouseEvent('press', lowCol, barRow));
    expect(picker.handleMouse(mouseEvent('click', maxCol, barRow))).toEqual({ handled: true });
    expect(onSelect).not.toHaveBeenCalled();

    picker.handleMouse(mouseEvent('press', maxCol, barRow));
    expect(picker.handleMouse(mouseEvent('click', maxCol, barRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('max');

    const fresh = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });
    fresh.focused = true;
    const freshLines = fresh.render(120).map(strip);
    const freshBarRow = freshLines.findIndex((line) => line.includes('[ High ]'));
    const freshMaxCol = freshLines[freshBarRow]!.indexOf('Max');
    expect(fresh.handleMouse(mouseEvent('click', freshMaxCol, freshBarRow))).toEqual({
      handled: true,
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
