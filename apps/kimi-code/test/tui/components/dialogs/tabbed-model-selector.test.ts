import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replaceAll(SGR, '');
const TAB = '\t';
const SHIFT_TAB = `${ESC}[Z`;
const RIGHT = `${ESC}[C`;
const PRIMARY_BG = '48;2;79;168;255';

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
    height: 30,
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

function model(displayName: string, provider: string): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

function make(): {
  component: TabbedModelSelectorComponent;
  onSelect: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const component = new TabbedModelSelectorComponent({
    models: {
      k2: model('Kimi K2', 'managed:kimi-code'),
      gpt: model('GPT-5', 'openai'),
    },
    currentValue: 'k2',
    currentThinkingEffort: 'off',
    onSelect,
    onCancel: vi.fn(),
  });
  component.focused = true;
  return { component, onSelect };
}

describe('TabbedModelSelectorComponent', () => {
  let previousLevel: typeof chalk.level;
  const previousPalette = currentTheme.palette;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });
  afterAll(() => {
    chalk.level = previousLevel;
    currentTheme.setPalette(previousPalette);
  });

  it('renders an "All" + per-provider tab strip', () => {
    const out = strip(make().component.render(120).join('\n'));
    expect(out).toContain('All');
    expect(out).toContain('Kimi Code');
    expect(out).toContain('openai');
  });

  it('highlights the active tab with a filled background (AskUserQuestion style)', () => {
    const raw = make().component.render(120).join('\n');
    expect(raw).toContain(PRIMARY_BG);
  });

  it('repaints the tab strip from the current theme palette without remounting', () => {
    const { component } = make();
    const stripLine = (lines: string[]): string =>
      lines.find((l) => l.includes('All') && l.includes('openai')) ?? '';
    const previous = currentTheme.palette;
    try {
      currentTheme.setPalette(darkColors);
      const darkStrip = stripLine(component.render(120));
      currentTheme.setPalette(lightColors);
      const lightStrip = stripLine(component.render(120));
      expect(darkStrip).not.toBe(lightStrip);
    } finally {
      currentTheme.setPalette(previous);
    }
  });

  it('opens on the All tab by default (showing every provider\'s models)', () => {
    const out = strip(make().component.render(120).join('\n'));
    expect(out).toContain('Kimi K2');
    expect(out).toContain('GPT-5');
  });

  it('cycles provider tabs with Tab', () => {
    const { component } = make();
    component.handleInput(TAB);
    component.handleInput(TAB);
    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('GPT-5');
    expect(out).not.toContain('Kimi K2');
  });

  it('forwards thinking toggle (←/→) and selection (Enter) to the active tab', () => {
    const { component, onSelect } = make();
    component.handleInput(RIGHT);
    component.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'k2', thinking: 'on' });
  });

  it('frames the tab strip with a blank line above and below it', () => {
    const lines = make().component.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate') && l.includes('Esc cancel'));
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe('');
    expect(stripIdx).toBe(hintIdx + 2);
    expect(lines[stripIdx + 1]).toBe('');
  });

  it('mentions the Tab provider switch first in the hint line', () => {
    const lines = make().component.render(120).map(strip);
    const hint = lines.find((l) => l.includes('navigate') && l.includes('Esc cancel'));
    expect(hint).toBeDefined();
    expect(hint).toContain('Tab toggle provider');
    expect(hint!.indexOf('Tab toggle provider')).toBeLessThan(hint!.indexOf('↑↓ navigate'));
  });

  it('renders the default title, and a custom title when provided', () => {
    expect(strip(make().component.render(120).join('\n'))).toContain('Select a model');

    const titled = new TabbedModelSelectorComponent({
      models: { k2: model('Kimi K2', 'managed:kimi-code') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      title: ' Choose a model for this task',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = strip(titled.render(120).join('\n'));
    expect(out).toContain('Choose a model for this task');
    expect(out).not.toContain('Select a model ');
  });

  it('keeps the tab strip between hint and list when a warning line is present', () => {
    const component = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = component.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate') && l.includes('Esc cancel'));
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
    expect(lines[hintIdx + 2]).toBe('');
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(stripIdx).toBe(hintIdx + 3);
    expect(lines[stripIdx + 1]).toBe('');
    expect(lines.findIndex((l) => l.includes('Kimi K2'))).toBeGreaterThan(stripIdx);
  });

  it('syncs focused setter immediately to the active selector and across tab switches', () => {
    useFakeDate();
    const { component, onSelect } = make();
    component.focused = false;
    const lines = component.render(120).map(strip);
    const modelRow = lines.findIndex((line) => line.includes('Kimi K2'));
    const tabRow = lines.findIndex((line) => line.includes('All') && line.includes('openai'));
    const openaiCol = lines[tabRow]!.indexOf('openai');
    vi.advanceTimersByTime(300);

    expect(component.handleMouse(mouseEvent('press', openaiCol, tabRow))).toEqual({
      handled: true,
    });
    expect(component.handleMouse(mouseEvent('click', openaiCol, tabRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(strip(component.render(120).join('\n'))).toContain('Kimi K2');

    expect(component.handleMouse(mouseEvent('click', 6, modelRow))).toEqual({
      handled: true,
      focus: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    component.focused = true;
    component.handleInput(TAB);
    const kimiLines = component.render(120).map(strip);
    const kimiRow = kimiLines.findIndex((line) => line.includes('Kimi K2'));
    expect(component.handleMouse(mouseEvent('press', 6, kimiRow))).toEqual({
      handled: true,
      render: false,
    });
    expect(component.handleMouse(mouseEvent('click', 6, kimiRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(onSelect).toHaveBeenCalledWith({ alias: 'k2', thinking: 'off' });

    component.handleInput(SHIFT_TAB);
    expect(strip(component.render(120).join('\n'))).toContain('GPT-5');
  });

  it('switches tabs on tab clicks and supports hover, click, wheel, and thinking clicks in body (with warning offset)', () => {
    useFakeDate();
    const onSelect = vi.fn();
    const component = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      warning: 'Switching may increase token usage.',
      onSelect,
      onCancel: vi.fn(),
    });
    component.focused = true;
    const lines = component.render(120).map(strip);
    const tabRow = lines.findIndex((line) => line.includes('All') && line.includes('openai'));
    const openaiCol = lines[tabRow]!.indexOf('openai');
    const gptRow = lines.findIndex((line) => line.includes('GPT-5'));

    expect(component.handleMouse(mouseEvent('click', openaiCol, tabRow))).toEqual({
      handled: true,
    });
    expect(strip(component.render(120).join('\n'))).toContain('Kimi K2');

    vi.advanceTimersByTime(300);
    component.handleMouse(mouseEvent('press', openaiCol, tabRow));
    expect(component.handleMouse(mouseEvent('click', 6, gptRow))).toEqual({ handled: true });
    expect(onSelect).not.toHaveBeenCalled();

    expect(component.handleMouse(mouseEvent('press', openaiCol, tabRow))).toEqual({
      handled: true,
      render: false,
    });
    expect(component.handleMouse(mouseEvent('click', openaiCol, tabRow))).toEqual({
      handled: true,
      render: true,
    });

    const openaiLines = component.render(120).map(strip);
    expect(openaiLines.join('\n')).toContain('GPT-5');
    expect(openaiLines.join('\n')).not.toContain('Kimi K2');

    const thinkingRow = openaiLines.findIndex((line) => line.includes('[ On ]'));
    const offCol = openaiLines[thinkingRow]!.indexOf('Off');
    expect(component.handleMouse(mouseEvent('press', offCol, thinkingRow))).toEqual({
      handled: true,
      render: false,
    });
    expect(component.handleMouse(mouseEvent('click', offCol, thinkingRow))).toEqual({
      handled: true,
      render: true,
    });
    expect(onSelect).not.toHaveBeenCalled();

    const afterToggle = component.render(120).map(strip);
    expect(afterToggle[thinkingRow]).toContain('[ Off ]');

    const openaiGptRow = afterToggle.findIndex((line) => line.includes('GPT-5'));
    expect(component.handleMouse(mouseEvent('wheel', 6, tabRow, 1))).toEqual({
      handled: true,
      render: false,
    });
    component.handleMouse(mouseEvent('press', 6, openaiGptRow));
    component.handleMouse(mouseEvent('click', 6, openaiGptRow));
    expect(onSelect).toHaveBeenCalledWith({ alias: 'gpt', thinking: 'off' });
  });

  it('steps overflowed tabs when clicking < and > arrows', () => {
    useFakeDate();
    const component = new TabbedModelSelectorComponent({
      models: {
        m1: model('Model One', 'provider-alpha'),
        m2: model('Model Two', 'provider-beta'),
        m3: model('Model Three', 'provider-gamma'),
        m4: model('Model Four', 'provider-delta'),
      },
      currentValue: 'm1',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    component.focused = true;
    const narrowWidth = 30;
    const lines = component.render(narrowWidth).map(strip);
    const tabRow = lines.findIndex((line) => line.includes('All') && line.includes('>'));
    expect(tabRow).toBeGreaterThanOrEqual(0);
    const nextCol = lines[tabRow]!.lastIndexOf('>');

    vi.advanceTimersByTime(300);
    component.handleMouse(mouseEvent('press', nextCol, tabRow));
    component.handleMouse(mouseEvent('click', nextCol, tabRow));

    let afterNext = component.render(narrowWidth).map(strip);
    expect(afterNext.join('\n')).toContain('Model One');
    expect(afterNext.join('\n')).not.toContain('Model Two');

    const nextCol2 = afterNext[tabRow]!.lastIndexOf('>');
    component.handleMouse(mouseEvent('press', nextCol2, tabRow));
    component.handleMouse(mouseEvent('click', nextCol2, tabRow));

    afterNext = component.render(narrowWidth).map(strip);
    expect(afterNext.join('\n')).toContain('Model Two');
    expect(afterNext[tabRow]).toContain('<');

    const prevCol = afterNext[tabRow]!.indexOf('<');
    component.handleMouse(mouseEvent('press', prevCol, tabRow));
    component.handleMouse(mouseEvent('click', prevCol, tabRow));

    const afterPrev = component.render(narrowWidth).map(strip);
    expect(afterPrev.join('\n')).toContain('Model One');
    expect(afterPrev.join('\n')).not.toContain('Model Two');
  });
});
