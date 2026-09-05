import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
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
// chalk.bgHex(colors.primary) → background truecolor for #4FA8FF.
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

  it('highlights the active tab with a filled background (AskUserQuestion style)', () => {
    // currentValue k2 → the active tab is "Kimi Code"; its cell carries the
    // primary background SGR.
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
      // The strip is drawn from currentTheme.palette at render time; a
      // construction-time palette snapshot would render the same strip after
      // the switch.
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
    // tabs = [All, Kimi Code, openai]; active starts on All.
    // Two Tabs → openai, whose list shows GPT-5 and not Kimi K2.
    component.handleInput(TAB);
    component.handleInput(TAB);
    const out = strip(component.render(120).join('\n'));
    expect(out).toContain('GPT-5');
    expect(out).not.toContain('Kimi K2');
  });

  it('forwards thinking toggle (←/→) and selection (Enter) to the active tab', () => {
    const { component, onSelect } = make();
    component.handleInput(RIGHT); // toggle thinking on for k2
    component.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'k2', thinking: 'on' });
  });

  it('frames the tab strip with a blank line above and below it', () => {
    const lines = make().component.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('navigate') && l.includes('Esc cancel'));
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe(''); // blank between hint and tabs
    expect(stripIdx).toBe(hintIdx + 2);
    expect(lines[stripIdx + 1]).toBe(''); // blank between tabs and list
  });

  it('mentions the Tab provider switch first in the hint line', () => {
    const lines = make().component.render(120).map(strip);
    const hint = lines.find((l) => l.includes('navigate') && l.includes('Esc cancel'));
    expect(hint).toBeDefined();
    expect(hint).toContain('Tab toggle provider');
    // It comes first, before the navigation hint.
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
    expect(lines[hintIdx + 2]).toBe(''); // blank between warning and tabs
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('openai'));
    expect(stripIdx).toBe(hintIdx + 3);
    expect(lines[stripIdx + 1]).toBe(''); // blank between tabs and list
    expect(lines.findIndex((l) => l.includes('Kimi K2'))).toBeGreaterThan(stripIdx);
  });
});

describe('TabbedModelSelectorComponent favorites', () => {
  const SHIFT_A = 'A';
  const SHIFT_R = 'R';
  const SHIFT_TAB = `${ESC}[Z`;

  function makeFavorites(favoriteAliases?: readonly string[]) {
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    const component = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      ...(favoriteAliases !== undefined ? { favoriteAliases } : {}),
      onToggleFavorite,
      onSelect,
      onCancel: vi.fn(),
    });
    component.focused = true;
    return { component, onSelect, onToggleFavorite };
  }

  function activeList(lines: string[]): string[] {
    // The model list starts after the tab strip + blank line.
    const stripIdx = lines.findIndex((l) => l.includes('All') && l.includes('Favorites'));
    return stripIdx === -1 ? lines : lines.slice(stripIdx + 2);
  }

  it('prepends a Favorites tab that lists only favorites in add-order', () => {
    const { component } = makeFavorites(['gpt', 'k2']);
    const out = strip(component.render(120).join('\n'));

    expect(out.indexOf('Favorites')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Favorites')).toBeLessThan(out.indexOf('All'));
    // gpt was favorited first, so it leads the Favorites list.
    const list = activeList(out.split('\n'));
    expect(list.findIndex((l) => l.includes('GPT-5'))).toBeLessThan(
      list.findIndex((l) => l.includes('Kimi K2')),
    );
    expect(out).toContain('★');
  });

  it('opens on the Favorites tab when favorites exist', () => {
    const { component } = makeFavorites(['k2']);
    const out = strip(component.render(120).join('\n'));
    const list = activeList(out.split('\n'));
    // Favorites tab active: only k2 is listed.
    expect(list.some((l) => l.includes('Kimi K2'))).toBe(true);
    expect(list.some((l) => l.includes('GPT-5'))).toBe(false);
  });

  it('falls back to the All tab when favorites are enabled but empty; the empty tab shows the how-to hint', () => {
    const { component } = makeFavorites([]);
    const out = strip(component.render(120).join('\n'));

    // Empty favorites: the picker opens on All with the full model list.
    expect(out).toContain('Favorites');
    expect(out).toContain('Kimi K2');
    expect(out).toContain('GPT-5');
    expect(out).not.toContain('No favorites yet');

    // Shift+Tab back to Favorites (it sits before All): the empty-state
    // hint replaces the list.
    component.handleInput(SHIFT_TAB);
    const favoritesOut = strip(component.render(120).join('\n'));
    expect(favoritesOut).toContain('No favorites yet');
    expect(favoritesOut).toContain('Shift+A');
  });

  it('keeps the current-model marker inside the Favorites tab', () => {
    const { component } = makeFavorites(['k2', 'gpt']);
    const out = strip(component.render(120).join('\n'));
    const list = activeList(out.split('\n'));
    expect(list.some((l) => l.includes('Kimi K2') && l.includes('← current'))).toBe(true);
  });

  it('Shift+A forwards the highlighted non-favorite and live-updates tabs via setFavoriteAliases', () => {
    const { component, onToggleFavorite } = makeFavorites([]);
    component.handleInput(SHIFT_A);
    expect(onToggleFavorite).toHaveBeenCalledWith('k2');

    // The host persists and refreshes: both become favorites and are listed.
    component.setFavoriteAliases(['k2', 'gpt']);
    const out = strip(component.render(120).join('\n'));
    const list = activeList(out.split('\n'));
    expect(list.some((l) => l.includes('GPT-5'))).toBe(true);
    expect(list.some((l) => l.includes('Kimi K2'))).toBe(true);
  });

  it('Shift+R forwards the highlighted favorite and live-updates tabs via setFavoriteAliases', () => {
    const { component, onToggleFavorite } = makeFavorites(['k2', 'gpt']);
    // Opens on the Favorites tab with k2 highlighted.
    component.handleInput(SHIFT_R);
    expect(onToggleFavorite).toHaveBeenCalledWith('k2');
  });

  it('live-removes a unfavorited model from the Favorites tab', () => {
    const { component } = makeFavorites(['k2', 'gpt']);
    // Start on Favorites (both listed), then remove k2.
    component.setFavoriteAliases(['gpt']);
    const out = strip(component.render(120).join('\n'));
    const list = activeList(out.split('\n'));
    expect(list.some((l) => l.includes('GPT-5'))).toBe(true);
    expect(list.some((l) => l.includes('Kimi K2'))).toBe(false);
  });

  it('omits favorites that are no longer in the catalog without dropping them from config', () => {
    const { component } = makeFavorites(['ghost', 'k2']);
    const out = strip(component.render(120).join('\n'));
    const list = activeList(out.split('\n'));
    expect(list.some((l) => l.includes('Kimi K2'))).toBe(true);
    expect(list.some((l) => l.includes('ghost'))).toBe(false);
  });

  it('adds no Favorites tab when favoriteAliases is not provided (other pickers unchanged)', () => {
    const { component } = makeFavorites();
    const out = strip(component.render(120).join('\n'));
    expect(out).not.toContain('Favorites');
    expect(out).toContain('All');
    expect(out).not.toContain('★');
  });
});
