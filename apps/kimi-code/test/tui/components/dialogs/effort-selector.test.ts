import { TuiAltScreen } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import { describe, expect, it, vi } from 'vitest';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

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

  it('selects effort segments on mouse click, tolerates 1-col horizontal drift, supports Alt+click session-only, and guards unfocused first click', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });
    const vt = new VirtualTerminal(80, 10);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(picker);
    ui.start();
    await vt.waitForRender();
    try {
      const viewport = vt.getViewport().map(strip);
      const segRow = viewport.findIndex((line) => line.includes('[ High ]'));
      expect(segRow).toBeGreaterThan(0);
      const lowCol = viewport[segRow]!.indexOf('Low') + 1;
      const lowRightEdgeCol = viewport[segRow]!.indexOf('Low') + 5;
      const maxCol = viewport[segRow]!.indexOf('Max') + 1;

      now += 500;
      vt.sendInput(`\u001B[<0;${String(lowCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(lowCol)};${String(segRow + 1)}m`);
      await vt.waitForRender();
      expect(picker.focused).toBe(true);
      expect(onSelect).not.toHaveBeenCalled();

      vt.sendInput(`\u001B[<0;${String(lowCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<32;${String(lowCol + 10)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(lowCol + 10)};${String(segRow + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).not.toHaveBeenCalled();
      expect(vt.getViewport().map(strip)[segRow]).toContain('[ High ]');

      vt.sendInput(`\u001B[<0;${String(lowRightEdgeCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(lowRightEdgeCol + 1)};${String(segRow + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('low');

      vt.sendInput(`\u001B[<8;${String(maxCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<8;${String(maxCol)};${String(segRow + 1)}m`);
      await vt.waitForRender();
      expect(onSessionOnlySelect).toHaveBeenCalledExactlyOnceWith('max');
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });
});
