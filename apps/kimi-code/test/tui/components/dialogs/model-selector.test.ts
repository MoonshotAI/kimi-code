import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { currentTheme } from '#/tui/theme';
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

function effortModel(
  displayName: string,
  supportEfforts: string[],
  defaultEffort?: string,
  capabilities: string[] = ['thinking'],
): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities,
    supportEfforts,
    defaultEffort,
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
      currentThinkingEffort: 'on',
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
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    // "/" no longer toggles thinking (it used to); here it is simply ignored.
    picker.handleInput('/');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });

    // Right arrow flips the draft (true -> false).
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'off' });

    // Left arrow flips it back.
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });
  });

  it('shows the Left/Right thinking hint only for toggleable models', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'off',
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
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    // Always-on: On selected, Off greyed out with an explanation.
    const alwaysOut = text(picker);
    expect(alwaysOut).toContain('[ On ]');
    expect(alwaysOut).toContain('Off (Unsupported)');
    expect(alwaysOut).not.toContain('Always on');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: 'on' });

    // Unsupported: Off selected, On greyed out — same style, mirrored.
    picker.handleInput(DOWN);
    const plainOut = text(picker);
    expect(plainOut).toContain('On (Unsupported)');
    expect(plainOut).toContain('[ Off ]');
    expect(plainOut).not.toContain('] unsupported');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: 'off' });
  });

  it('ignores Left/Right on always-on and unsupported models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: model('Kimi Thinking', ['always_thinking']),
        plain: model('Kimi Plain', ['tool_use']),
      },
      currentValue: 'always',
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: 'on' });

    picker.handleInput(DOWN);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: 'off' });
  });

  it('renders the unavailable thinking segment muted', () => {
    const picker = new ModelSelectorComponent({
      models: { always: model('Kimi Thinking', ['always_thinking']) },
      currentValue: 'always',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const raw = picker.render(120).join('\n');
    expect(raw).toContain(currentTheme.fg('textMuted', '  Off (Unsupported)  '));
  });

  it('keeps the thinking draft when moving across models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        plain: model('Kimi Plain', ['tool_use']),
        thinking: model('Kimi Thinking', ['thinking']),
      },
      currentValue: 'plain',
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(DOWN); // -> thinking model (defaults On)
    picker.handleInput(RIGHT); // toggle -> Off
    picker.handleInput(UP); // -> plain
    picker.handleInput(DOWN); // -> thinking (the Off override persists)
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'thinking', thinking: 'off' });
  });

  it('defaults a thinking-capable model to On but keeps the current model state', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        current: model('Kimi Current', ['thinking']),
        other: model('Kimi Other', ['thinking']),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off', // thinking deliberately off on the active model
      onSelect,
      onCancel: vi.fn(),
    });

    // The active model reflects its live (off) state.
    expect(text(picker)).toContain('[ Off ]');
    picker.handleInput(DOWN); // -> the other thinking-capable model
    // A capable, non-active model defaults to On without any toggle.
    expect(text(picker)).toContain('[ On ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'other', thinking: 'on' });
  });

  it('fuzzy-filters by typing and reports a match count', () => {
    const onCancel = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { k2: model('Kimi K2'), turbo: model('Kimi Turbo') },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
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
      currentThinkingEffort: 'off',
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
      currentThinkingEffort: 'off',
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

  it('invokes onSessionOnlySelect on Alt+S with the effective thinking state', () => {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });

    // Toggle thinking Off, then Alt+S applies the choice to the session only.
    picker.handleInput(RIGHT);
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith({ alias: 'kimi', thinking: 'off' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores Alt+S and hides its hint when onSessionOnlySelect is not provided', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(`${ESC}s`);
    expect(onSelect).not.toHaveBeenCalled();
    expect(text(picker)).not.toContain('Alt+S session-only');
  });

  it('shows the Alt+S session-only hint when onSessionOnlySelect is provided', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      onSelect: vi.fn(),
      onSessionOnlySelect: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(text(picker)).toContain('Alt+S session-only');
  });

  it('renders effort segments with the default effort highlighted', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high') },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    // The default effort (high) is the active segment.
    expect(out).toContain('[ High ]');
    // All declared efforts plus the Off entry are present.
    expect(out).toContain('Low');
    expect(out).toContain('Max');
    expect(out).toContain('Off');
    // Multi-segment control advertises the switch hint.
    expect(out).toContain('Thinking  (←→ to switch)');
  });

  it('cycles efforts with Left/Right and clamps at the ends', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high') },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    // high -> max (Right), then clamp on a second Right.
    picker.handleInput(RIGHT);
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'max' });

    // max -> high -> low -> off (Left x3), then clamp on another Left.
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'off' });
  });

  it('always-on effort models hide Off and clamp selection at the last effort', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        kimi: effortModel('Kimi K2', ['low', 'high', 'max'], 'high', ['always_thinking']),
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    const raw = picker.render(120).join('\n');
    // Off is not surfaced at all — the selectable segments are effort-only.
    expect(raw).not.toContain('Off (Unsupported)');
    // The active effort is still highlighted.
    expect(strip(raw)).toContain('[ High ]');

    // Cycling clamps at the last effort and never reaches Off.
    picker.handleInput(RIGHT); // high -> max
    picker.handleInput(RIGHT); // clamp at max
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'max' });
  });

  it('defaults an effort model without a current level to its defaultEffort', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        other: effortModel('Kimi Other', ['low', 'high', 'max'], 'max'),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    // Non-current effort model falls back to its declared defaultEffort.
    expect(text(picker)).toContain('[ Max ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'other', thinking: 'max' });
  });

  it('falls back to the middle effort when an effort model has no defaultEffort', () => {
    const picker = new ModelSelectorComponent({
      models: {
        other: effortModel('Kimi Other', ['low', 'medium', 'high']),
      },
      currentValue: 'current',
      currentThinkingEffort: 'off',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    // support_efforts present but default_effort absent -> default to the
    // middle entry (medium), not a hardcoded level.
    expect(text(picker)).toContain('[ Medium ]');
  });
});

describe('ModelSelectorComponent overrides', () => {
  it('uses overridden support_efforts for selectable efforts', () => {
    const picker = new ModelSelectorComponent({
      models: {
        kimi: {
          ...effortModel('Kimi K2', ['low', 'high', 'max'], 'max'),
          overrides: { supportEfforts: ['low', 'high'] },
        },
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'max',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).not.toContain('Max');
  });
});
