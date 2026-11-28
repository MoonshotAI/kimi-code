import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { ScrollView, Text, TuiAltScreen, VStack } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { currentTheme } from '#/tui/theme';
import { darkColors, lightColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replaceAll(SGR, '');
const TAB = '\t';
const RIGHT = `${ESC}[C`;
const PRIMARY_BG = '48;2;79;168;255';

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

  it('labels a provider tab and its models with the provider display name when one is set', () => {
    const component = new TabbedModelSelectorComponent({
      models: { gpt: model('GPT-5', 'openai') },
      providers: { openai: { displayName: 'My Gateway' } },
      currentValue: 'gpt',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('My Gateway');
    expect(out).toMatch(/GPT-5\s+My Gateway/);
    expect(out).not.toContain('openai');
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

  it('switches provider tabs, toggles thinking, and selects a model on mouse clicks in fullscreen', async () => {
    let now = 50_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onSelect = vi.fn();
    const component = new TabbedModelSelectorComponent({
      models: {
        k1: model('Kimi One', 'managed:kimi-code'),
        k2: model('Kimi Two', 'managed:kimi-code'),
        k3: model('Kimi Three', 'managed:kimi-code'),
        k4: model('Kimi Four', 'managed:kimi-code'),
        k5: model('Kimi Five', 'managed:kimi-code'),
        g1: model('GPT-4o', 'openai'),
        g2: model('GPT-4.1', 'openai'),
        g3: model('GPT-4.5', 'openai'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'gpt',
      currentThinkingEffort: 'off',
      layout: { maxBodyRows: 3 },
      onSelect,
      onCancel: vi.fn(),
    });
    const vt = new VirtualTerminal(90, 18);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(component);
    ui.start();
    ui.setFocus(component);
    await vt.waitForRender();
    try {
      now += 500;
      let screen = vt.getViewport().map(strip);
      expect(screen.join('\n')).toContain('❯ GPT-5');
      const tabRow = screen.findIndex((line) => line.includes('All') && line.includes('openai'));
      expect(tabRow).toBeGreaterThan(0);
      const openaiCol = screen[tabRow]!.indexOf('openai') + 2;
      const allCol = screen[tabRow]!.indexOf('All') + 2;

      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRow + 1)}m`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(screen.join('\n')).toContain('GPT-5');
      expect(screen.join('\n')).not.toContain('Kimi One');

      vt.sendInput(`\u001B[<0;${String(allCol)};${String(tabRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(allCol)};${String(tabRow + 1)}m`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(screen.join('\n')).toContain('❯ GPT-5');

      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRow + 1)}m`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);

      const segRow = screen.findIndex((line) => line.includes('[ Off ]') && line.includes('On'));
      expect(segRow).toBeGreaterThan(0);
      const onCol = screen[segRow]!.indexOf('On') + 1;
      vt.sendInput(`\u001B[<0;${String(onCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(onCol)};${String(segRow + 1)}m`);
      await vt.waitForRender();

      screen = vt.getViewport().map(strip);
      const gptRow = screen.findIndex((line) => line.includes('GPT-5'));
      vt.sendInput(`\u001B[<0;10;${String(gptRow + 1)}M`);
      vt.sendInput(`\u001B[<0;10;${String(gptRow + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({ alias: 'gpt', thinking: 'on' });
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });

  it('keeps bottom-anchored provider tab strip stationary across uneven tabs and steps tabs on wheel', async () => {
    let now = 60_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const component = new TabbedModelSelectorComponent({
      models: {
        k1: model('Kimi One', 'managed:kimi-code'),
        k2: model('Kimi Two', 'managed:kimi-code'),
        k3: model('Kimi Three', 'managed:kimi-code'),
        k4: model('Kimi Four', 'managed:kimi-code'),
        k5: model('Kimi Five', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k1',
      currentThinkingEffort: 'on',
      layout: { maxBodyRows: 5 },
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const transcript = new ScrollView(new Text('msg-1\nmsg-2\nmsg-3', 0, 0), {
      follow: 'end',
      primary: true,
    });
    const vt = new VirtualTerminal(90, 20);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: component, shrink: 1, minSize: 3 },
      ]),
    );
    ui.start();
    ui.setFocus(component);
    await vt.waitForRender();
    try {
      now += 500;
      const before = vt.getViewport().map(strip);
      const tabRowBefore = before.findIndex(
        (line) => line.includes('All') && line.includes('openai'),
      );
      expect(tabRowBefore).toBeGreaterThan(0);
      const openaiCol = before[tabRowBefore]!.indexOf('openai') + 2;

      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRowBefore + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(openaiCol)};${String(tabRowBefore + 1)}m`);
      await vt.waitForRender();
      const onOpenai = vt.getViewport().map(strip);
      const tabRowAfter = onOpenai.findIndex(
        (line) => line.includes('All') && line.includes('openai'),
      );
      expect(tabRowAfter).toBe(tabRowBefore);
      expect(onOpenai.join('\n')).toContain('GPT-5');
      expect(onOpenai.join('\n')).not.toContain('Kimi One');

      vt.sendInput(`\u001B[<65;${String(openaiCol)};${String(tabRowBefore + 1)}M`);
      await vt.waitForRender();
      expect(vt.getViewport().map(strip).join('\n')).toContain('Kimi One');
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });
});
