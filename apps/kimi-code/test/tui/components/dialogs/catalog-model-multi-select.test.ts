import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { CatalogModelMultiSelectComponent } from '#/tui/components/dialogs/catalog-model-multi-select';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function rendered(component: { render: (w: number) => string[] }, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

const ESC = String.fromCodePoint(27);
const ENTER = String.fromCodePoint(13);
const SPACE = ' ';
const TAB = String.fromCodePoint(9);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

describe('CatalogModelMultiSelectComponent', () => {
  function buildModels(): Record<string, ModelAlias> {
    return {
      'prov/alpha': {
        provider: 'prov',
        model: 'alpha',
        maxContextSize: 1000,
        displayName: 'Alpha',
        capabilities: ['thinking'],
      },
      'prov/beta': {
        provider: 'prov',
        model: 'beta',
        maxContextSize: 1000,
        displayName: 'Beta',
        capabilities: ['thinking'],
      },
      'prov/gamma': {
        provider: 'prov',
        model: 'gamma',
        maxContextSize: 1000,
        displayName: 'Gamma',
        capabilities: ['thinking'],
      },
    };
  }

  function makeSelector(
    initial: { selectedAliases?: readonly string[]; defaultAlias?: string } = {},
  ) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const selector = new CatalogModelMultiSelectComponent({
      models: buildModels(),
      currentThinking: true,
      colors: darkColors,
      selectedAliases: initial.selectedAliases,
      defaultAlias: initial.defaultAlias,
      searchable: true,
      onSelect,
      onCancel,
    });
    return { selector, onSelect, onCancel };
  }

  it('keeps checked models when the search query changes', () => {
    const { selector } = makeSelector();
    selector.handleInput(SPACE); // check Alpha (highlighted)

    for (const ch of 'beta') selector.handleInput(ch); // filter to Beta
    selector.handleInput(SPACE); // check Beta

    selector.handleInput(ESC); // clear the query, restore full list
    const out = rendered(selector);
    expect(out).toContain('[x] Alpha (prov)');
    expect(out).toContain('[x] Beta (prov)');
    expect(out).toContain('[ ] Gamma (prov)');
  });

  it('returns aliases in check order with the first checked as default', () => {
    const { selector, onSelect } = makeSelector();
    selector.handleInput(DOWN); // highlight Beta
    selector.handleInput(SPACE); // check Beta first
    selector.handleInput(UP); // highlight Alpha
    selector.handleInput(SPACE); // check Alpha second
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/beta', 'prov/alpha'],
      defaultAlias: 'prov/beta',
      thinking: true,
    });
  });

  it('preselects configured aliases and ignores aliases outside the catalog', () => {
    const { selector, onSelect } = makeSelector({
      selectedAliases: ['prov/beta', 'prov/missing'],
    });

    const out = rendered(selector);
    expect(out).toContain('[ ] Alpha (prov)');
    expect(out).toContain('[x] Beta (prov)');
    expect(out).toContain('[ ] Gamma (prov)');
    expect(out).toContain('❯ [x] Beta (prov) ← default');

    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/beta'],
      defaultAlias: 'prov/beta',
      thinking: true,
    });
  });

  it('uses an initial default alias only when it is checked', () => {
    const { selector, onSelect } = makeSelector({
      selectedAliases: ['prov/alpha', 'prov/beta'],
      defaultAlias: 'prov/beta',
    });

    const defaults = rendered(selector)
      .split('\n')
      .filter((line) => line.includes('← default'));
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toContain('❯ [x] Beta (prov)');

    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/alpha', 'prov/beta'],
      defaultAlias: 'prov/beta',
      thinking: true,
    });
  });

  it('ignores an initial default alias that is not checked', () => {
    const { selector, onSelect } = makeSelector({
      selectedAliases: ['prov/alpha'],
      defaultAlias: 'prov/beta',
    });

    const defaults = rendered(selector)
      .split('\n')
      .filter((line) => line.includes('← default'));
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toContain('❯ [x] Alpha (prov)');

    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/alpha'],
      defaultAlias: 'prov/alpha',
      thinking: true,
    });
  });

  it('Enter does nothing when no model is checked', () => {
    const { selector, onSelect, onCancel } = makeSelector();
    selector.handleInput(DOWN); // highlight Beta but don't check it
    selector.handleInput(ENTER);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows an empty-state hint until a model is checked', () => {
    const { selector } = makeSelector();
    expect(rendered(selector)).toContain('Press Space to select at least one model');

    selector.handleInput(SPACE); // check Alpha
    expect(rendered(selector)).not.toContain('Press Space to select at least one model');
  });

  it('Tab promotes the highlighted model to default, auto-checks it, and marks it in the render', () => {
    const { selector, onSelect } = makeSelector();
    selector.handleInput(DOWN); // highlight Beta
    selector.handleInput(TAB); // promote Beta to default (auto-checks it)

    const defaultLines = rendered(selector)
      .split('\n')
      .filter((line) => line.includes('← default'));
    expect(defaultLines).toHaveLength(1);
    expect(defaultLines[0]).toContain('Beta (prov)');

    selector.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/beta'],
      defaultAlias: 'prov/beta',
      thinking: true,
    });
  });

  it('Tab overrides the first-checked default without reordering aliases', () => {
    const { selector, onSelect } = makeSelector();
    selector.handleInput(SPACE); // check Alpha first
    selector.handleInput(DOWN); // highlight Beta
    selector.handleInput(SPACE); // check Beta second
    selector.handleInput(TAB); // promote Beta to default
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/alpha', 'prov/beta'],
      defaultAlias: 'prov/beta',
      thinking: true,
    });
  });

  it('reverts to the first-checked default when the promoted model is unchecked', () => {
    const { selector, onSelect } = makeSelector();
    selector.handleInput(SPACE); // check Alpha first
    selector.handleInput(DOWN); // highlight Beta
    selector.handleInput(SPACE); // check Beta
    selector.handleInput(TAB); // promote Beta to default
    selector.handleInput(SPACE); // uncheck Beta, clearing the explicit default
    selector.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith({
      aliases: ['prov/alpha'],
      defaultAlias: 'prov/alpha',
      thinking: true,
    });
  });
});
