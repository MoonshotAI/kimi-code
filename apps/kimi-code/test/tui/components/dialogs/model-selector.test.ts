import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { darkColors } from '#/tui/theme/colors';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function model(displayName: string, capabilities: string[] = ['thinking']): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
  } as unknown as ModelAlias;
}

function text(component: ModelSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ModelSelectorComponent', () => {
  it('lays out the provider as a right column and marks the current model', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinking: true,
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    // Model name on the left, provider on the right, with the current marker.
    expect(out).toMatch(/❯ Kimi K2\s+Kimi Code ← current/);
    // Provider is no longer inlined in parentheses next to the name.
    expect(out).not.toContain('Kimi K2 (Kimi Code)');
  });

  it('toggles thinking with Left/Right (not with "/")', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinking: true,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    // "/" no longer toggles thinking (it used to); here it is simply ignored.
    picker.handleInput('/');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: true });

    // Right arrow flips the draft (true -> false).
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: false });

    // Left arrow flips it back.
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: true });
  });

  it('shows the Left/Right thinking hint only for toggleable models', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinking: false,
      colors: darkColors,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Thinking  (←→ to switch)');
  });

  it('forces always-thinking models on and unsupported models off', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: model('Kimi Thinking', ['always_thinking']),
        plain: model('Kimi Plain', ['tool_use']),
      },
      currentValue: 'always',
      currentThinking: false,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    expect(text(picker)).toContain('[ Always on ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: true });

    picker.handleInput(DOWN);
    expect(text(picker)).toContain('[ Off ] unsupported');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: false });
  });

  it('keeps the thinking draft when moving across models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        plain: model('Kimi Plain', ['tool_use']),
        thinking: model('Kimi Thinking', ['thinking']),
      },
      currentValue: 'plain',
      currentThinking: false,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(DOWN); // -> thinking model (defaults On)
    picker.handleInput(RIGHT); // toggle -> Off
    picker.handleInput(UP); // -> plain
    picker.handleInput(DOWN); // -> thinking (the Off override persists)
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'thinking', thinking: false });
  });

  it('defaults a thinking-capable model to On but keeps the current model state', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        current: model('Kimi Current', ['thinking']),
        other: model('Kimi Other', ['thinking']),
      },
      currentValue: 'current',
      currentThinking: false, // thinking deliberately off on the active model
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    // The active model reflects its live (off) state.
    expect(text(picker)).toContain('[ Off ]');
    picker.handleInput(DOWN); // -> the other thinking-capable model
    // A capable, non-active model defaults to On without any toggle.
    expect(text(picker)).toContain('[ On ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'other', thinking: true });
  });

  it('fuzzy-filters by typing and reports a match count', () => {
    const onCancel = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { k2: model('Kimi K2'), turbo: model('Kimi Turbo') },
      currentValue: 'k2',
      currentThinking: false,
      colors: darkColors,
      searchable: true,
      onSelect: vi.fn(),
      onCancel,
    });

    picker.handleInput('t');
    picker.handleInput('u');
    const out = text(picker);
    expect(out).toContain('Search: tu');
    expect(out).toContain('Kimi Turbo');
    expect(out).not.toContain('Kimi K2');
    expect(out).toContain('1 / 2');

    // First Esc clears the query, second Esc cancels.
    picker.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a "more" indicator when the list overflows a page', () => {
    const models: Record<string, ModelAlias> = {};
    for (let i = 0; i < 12; i++) models[`m${String(i)}`] = model(`Model ${String(i)}`);
    const picker = new ModelSelectorComponent({
      models,
      currentValue: 'm0',
      currentThinking: false,
      colors: darkColors,
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // Default page size is 8, so 4 of the 12 models sit below the fold.
    expect(text(picker)).toContain('▼ 4 more');
  });

  it('never renders a line wider than the terminal', () => {
    const picker = new ModelSelectorComponent({
      models: {
        long: model('A Very Long Model Display Name That Should Be Truncated Hard'),
        cjk: model('超长的中文模型名称需要被正确截断处理'),
      },
      currentValue: 'long',
      currentThinking: false,
      colors: darkColors,
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [20, 40, 80, 120]) {
      for (const line of picker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
