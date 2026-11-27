import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { ScrollView, Text, TuiAltScreen, visibleWidth, VStack } from '@moonshot-ai/pi-tui';
import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
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
    expect(out).toMatch(/❯ Kimi K2\s+Kimi Code ← current/);
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

    picker.handleInput('/');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'off' });

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

  it('hides the Thinking footer when thinkingControl is false', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      thinkingControl: false,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(text(picker)).not.toContain('Thinking');
  });

  it('ignores Left/Right when thinkingControl is false', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2', ['thinking']) },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      thinkingControl: false,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'on' });
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

    const alwaysOut = text(picker);
    expect(alwaysOut).toContain('[ On ]');
    expect(alwaysOut).toContain('Off (Unsupported)');
    expect(alwaysOut).not.toContain('Always on');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: 'on' });

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

    picker.handleInput(DOWN);
    picker.handleInput(RIGHT);
    picker.handleInput(UP);
    picker.handleInput(DOWN);
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
      currentThinkingEffort: 'off',
      onSelect,
      onCancel: vi.fn(),
    });

    expect(text(picker)).toContain('[ Off ]');
    picker.handleInput(DOWN);
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
    expect(out).toContain('[ High ]');
    expect(out).toContain('Low');
    expect(out).toContain('Max');
    expect(out).toContain('Off');
    expect(out).toContain('Thinking  (←→ to switch)');
  });

  it('derives official Anthropic effort segments from the model name', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        opus: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          maxContextSize: 200000,
        },
      },
      currentValue: 'opus',
      currentThinkingEffort: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Low');
    expect(out).toContain('[ High ]');
    expect(out).toContain('Max');
    expect(out).toContain('Off');
    expect(out).not.toContain('Xhigh');

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith({ alias: 'opus', thinking: 'max' });
  });

  it('derives official always-on Anthropic models without an Off segment', () => {
    const picker = new ModelSelectorComponent({
      models: {
        fable: {
          provider: 'anthropic',
          model: 'claude-fable-5',
          maxContextSize: 200000,
        },
      },
      currentValue: 'fable',
      currentThinkingEffort: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(picker);
    expect(out).toContain('Xhigh');
    expect(out).toContain('Max');
    expect(out).not.toContain('Off');
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

    picker.handleInput(RIGHT);
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'kimi', thinking: 'max' });

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
    expect(raw).not.toContain('Off (Unsupported)');
    expect(strip(raw)).toContain('[ High ]');

    picker.handleInput(RIGHT);
    picker.handleInput(RIGHT);
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

    expect(text(picker)).toContain('[ Medium ]');
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('↑↓ navigate'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
    expect(lines.findIndex((l) => l.includes('Kimi K2'))).toBeGreaterThan(hintIdx + 1);
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new ModelSelectorComponent({
      models: { kimi: model('Kimi K2') },
      currentValue: 'kimi',
      currentThinkingEffort: 'on',
      warning,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(50).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('↑↓ navigate'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });
});

describe('ModelSelectorComponent effort descriptions', () => {
  it('updates descriptions for the highlighted effort and hides them for other providers', () => {
    const picker = new ModelSelectorComponent({
      models: {
        kimi: effortModel('Kimi K3', ['low', 'high', 'max'], 'high'),
        custom: { ...effortModel('Custom K3', ['low', 'high', 'max'], 'high'), provider: 'custom' },
      },
      currentValue: 'kimi',
      currentThinkingEffort: 'high',
      effortDescriptions: {
        low: 'Light reasoning.',
        high: 'Deeper reasoning.',
        max: 'Maximum reasoning.',
      },
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(text(picker)).toContain('Deeper reasoning.');
    const initialLineCount = picker.render(100).length;
    picker.handleInput(RIGHT);
    expect(text(picker)).toContain('Maximum reasoning.');
    expect(picker.render(100).length).toBe(initialLineCount);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    expect(text(picker)).toContain('Light reasoning.');
    picker.handleInput(LEFT);
    expect(text(picker)).not.toContain('Light reasoning.');
    expect(picker.render(100).length).toBe(initialLineCount);
    picker.handleInput(DOWN);
    expect(text(picker)).not.toContain('Deeper reasoning.');
    expect(picker.render(100).length).toBe(initialLineCount);
  });

  it('keeps docked model row screen positions stable when hovering between effort and binary thinking models', async () => {
    const picker = new ModelSelectorComponent({
      models: {
        k27: model('K2.7 Code Highspeed'),
        k3: effortModel('K3-256k', ['low', 'high', 'max'], 'high'),
      },
      currentValue: 'k3',
      currentThinkingEffort: 'high',
      layout: { maxBodyRows: 6 },
      effortDescriptions: {
        low: 'Light reasoning.',
        high: 'Deeper reasoning for complex tasks.',
        max: 'Maximum reasoning.',
      },
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const transcript = new ScrollView(new Text('chat-1\nchat-2\nchat-3', 0, 0), {
      follow: 'end',
      primary: true,
    });
    const vt = new VirtualTerminal(90, 18);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: picker, shrink: 1, minSize: 3 },
      ]),
    );
    ui.start();
    ui.setFocus(picker);
    await vt.waitForRender();
    try {
      const before = vt.getViewport().map(strip);
      const k27RowBefore = before.findIndex((line) => line.includes('K2.7 Code Highspeed'));
      const k3RowBefore = before.findIndex((line) => line.includes('K3-256k'));
      expect(k27RowBefore).toBeGreaterThan(0);
      expect(before.join('\n')).toContain('Deeper reasoning for complex tasks.');

      vt.sendInput(`\u001B[<35;10;${String(k27RowBefore + 1)}M`);
      await vt.waitForRender();
      const after = vt.getViewport().map(strip);
      expect(after.findIndex((line) => line.includes('K2.7 Code Highspeed'))).toBe(k27RowBefore);
      expect(after.findIndex((line) => line.includes('K3-256k'))).toBe(k3RowBefore);
      expect(after[k27RowBefore]).toContain('❯ K2.7 Code Highspeed');
    } finally {
      ui.stop();
    }
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

  it('previews hovered model thinking on mouse move, contains wheel across footer and body, and supports Alt+click session-only model selection', async () => {
    let now = 40_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        m1: effortModel('Model One', ['low', 'high'], 'low'),
        m2: effortModel('Model Two', ['low', 'high'], 'high'),
        m3: effortModel('Model Three', ['low', 'high'], 'low'),
        m4: effortModel('Model Four', ['low', 'high'], 'low'),
        m5: effortModel('Model Five', ['low', 'high'], 'low'),
      },
      currentValue: 'm1',
      currentThinkingEffort: 'low',
      layout: { maxBodyRows: 3 },
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });
    const transcript = new ScrollView(
      new Text(Array.from({ length: 12 }, (_, i) => `chat-${String(i + 1)}`).join('\n'), 0, 0),
      { follow: 'end', primary: true },
    );
    const vt = new VirtualTerminal(90, 20);
    const ui = new TuiAltScreen(vt);
    ui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: picker, shrink: 1, minSize: 3 },
      ]),
    );
    ui.start();
    ui.setFocus(picker);
    await vt.waitForRender();
    try {
      now += 500;
      let screen = vt.getViewport().map(strip);
      const segRow = screen.findIndex((line) => line.includes('[ Low ]') && line.includes('High'));
      expect(segRow).toBeGreaterThan(0);

      const m2Row = screen.findIndex((line) => line.includes('Model Two'));
      expect(m2Row).toBeGreaterThan(0);
      vt.sendInput(`\u001B[<35;10;${String(m2Row + 1)}M`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(screen[m2Row]).toContain('❯ Model Two');
      expect(screen[segRow]).toContain('[ High ]');
      expect(onSelect).not.toHaveBeenCalled();

      const m1Row = screen.findIndex((line) => line.includes('Model One'));
      vt.sendInput(`\u001B[<35;10;${String(m1Row + 1)}M`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(screen[segRow]).toContain('[ Low ]');

      const highCol = screen[segRow]!.indexOf('High') + 1;

      vt.sendInput(`\u001B[<0;${String(highCol)};${String(segRow + 1)}M`);
      vt.sendInput(`\u001B[<0;${String(highCol)};${String(segRow + 1)}m`);
      await vt.waitForRender();
      screen = vt.getViewport().map(strip);
      expect(screen[segRow]).toContain('[ High ]');

      vt.sendInput(`\u001B[<0;10;${String(m1Row + 1)}M`);
      vt.sendInput(`\u001B[<0;10;${String(m1Row + 1)}m`);
      await vt.waitForRender();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({ alias: 'm1', thinking: 'high' });

      const initialTop = transcript.scrollTop;
      for (let i = 0; i < 8; i++) {
        vt.sendInput(`\u001B[<65;10;${String(segRow + 1)}M`);
      }
      await vt.waitForRender();
      expect(transcript.scrollTop).toBe(initialTop);

      screen = vt.getViewport().map(strip);
      const m5Row = screen.findIndex((line) => line.includes('Model Five'));
      expect(m5Row).toBeGreaterThan(0);
      vt.sendInput(`\u001B[<8;10;${String(m5Row + 1)}M`);
      vt.sendInput(`\u001B[<8;10;${String(m5Row + 1)}m`);
      await vt.waitForRender();
      expect(onSessionOnlySelect).toHaveBeenCalledExactlyOnceWith({ alias: 'm5', thinking: 'low' });
    } finally {
      ui.stop();
      vi.restoreAllMocks();
    }
  });
});
