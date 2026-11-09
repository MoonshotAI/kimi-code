import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { MermaidPreferenceSelectorComponent } from '#/tui/components/dialogs/mermaid-preference-selector';
import {
  SettingsSelectorComponent,
  ThinkingDisplaySelectorComponent,
  ToolCallDensitySelectorComponent,
} from '#/tui/components/dialogs/settings-selector';
import { TranscriptContainer } from '#/tui/components/messages/transcript-container';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('MermaidPreferenceSelectorComponent', () => {
  it('maps the current preference onto the picker options with the current marker', () => {
    const selected: boolean[] = [];
    const enabledPicker = new MermaidPreferenceSelectorComponent({
      currentValue: true,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });
    const disabledPicker = new MermaidPreferenceSelectorComponent({
      currentValue: false,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });

    const enabledText = strip(enabledPicker.render(60).join('\n'));
    expect(enabledText).toContain('Mermaid diagrams');
    expect(enabledText).toContain('Draw mermaid code blocks as diagrams in the terminal.');
    expect(enabledText).toContain('Keep mermaid code blocks as highlighted source.');
    expect(enabledText).toContain('On ← current');
    expect(enabledText).not.toContain('final');

    const disabledText = strip(disabledPicker.render(60).join('\n'));
    expect(disabledText).toContain('Off ← current');

    enabledPicker.handleInput('\r');
    expect(selected).toEqual([true]);
    disabledPicker.handleInput('\r');
    expect(selected).toEqual([true, false]);
  });
});

describe('transcript display selectors', () => {
  it('lists the tool call and thinking settings only in fullscreen', () => {
    const settingsText = (fullscreen: boolean): string => {
      const picker = new SettingsSelectorComponent({
        fullscreen,
        onSelect: () => {},
        onCancel: () => {},
      });
      const firstPage = strip(picker.render(100).join('\n'));
      picker.handleInput('\u001B[C');
      return `${firstPage}\n${strip(picker.render(100).join('\n'))}`;
    };

    const regular = settingsText(false);
    expect(regular).toContain('Usage');
    expect(regular).not.toContain('Tool call density');
    expect(regular).not.toContain('Thinking folding');

    const fullscreen = settingsText(true).split('\n');
    expect(fullscreen).toContain('    Tool call density');
    expect(fullscreen).toContain('    Choose how much of each tool call the transcript shows.');
    expect(fullscreen).toContain('    Thinking folding');
    expect(fullscreen).toContain('    Choose whether to fold finished thinking.');
  });

  it('offers compact, balanced, and detailed tool calls with the current marker', () => {
    const onSelect = vi.fn();
    const picker = new ToolCallDensitySelectorComponent({
      current: { toolCallDensity: 'balanced', thinking: 'grouped' },
      onSelect,
      onCancel: () => {},
    });
    const lines = picker.render(100).map(strip);
    expect(lines).toContain(' Tool call density');
    expect(lines).toContain('  ❯ Balanced ← current');
    expect(lines).toContain('    Compact');
    expect(lines).toContain('    Fold tool calls into one summary. Subagents and questions stay as cards.');
    expect(lines).toContain('    Fold read-only calls. Edits and commands get one line each that you can open.');
    expect(lines).toContain('    Detailed');
    expect(lines).toContain('    Fold read-only calls. Edits and commands stay as full cards.');
    expect(lines.join('\n')).not.toMatch(/ungrouped/i);

    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('detailed');
  });

  it('marks no tool call row as current while the file holds ungrouped', () => {
    const onSelect = vi.fn();
    const picker = new ToolCallDensitySelectorComponent({
      current: { toolCallDensity: 'ungrouped', thinking: 'grouped' },
      onSelect,
      onCancel: () => {},
    });
    const text = strip(picker.render(100).join('\n'));
    expect(text).not.toContain('← current');
    expect(text).not.toMatch(/ungrouped/i);

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('compact');
  });

  it('offers folding and not folding thinking with the current marker', () => {
    const onSelect = vi.fn();
    const picker = new ThinkingDisplaySelectorComponent({
      current: { toolCallDensity: 'compact', thinking: 'grouped' },
      onSelect,
      onCancel: () => {},
    });
    const lines = picker.render(100).map(strip);
    expect(lines).toContain(' Thinking folding');
    expect(lines).toContain('  ❯ Fold thinking ← current');
    expect(lines).toContain('    Fold finished thinking into summary groups.');
    expect(lines).toContain("    Don't fold thinking");
    expect(lines).toContain('    Show each thinking block as a two-line preview.');

    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('ungrouped');
  });
});

describe('transcript display previews', () => {
  const down = '\u001B[B';

  function previewOf(lines: readonly string[]): string[] {
    const start = lines.indexOf(' Preview');
    expect(start).toBeGreaterThan(0);
    expect(lines[start + 1]).toBe('');
    return lines.slice(start + 2, -1).map((line) => line.trimEnd());
  }

  it('previews each tool call density with the real transcript at one steady height', () => {
    const picker = new ToolCallDensitySelectorComponent({
      current: { toolCallDensity: 'compact', thinking: 'grouped' },
      onSelect: () => {},
      onCancel: () => {},
    });
    const compact = picker.render(100).map(strip);
    picker.handleInput(down);
    const balanced = picker.render(100).map(strip);
    picker.handleInput(down);
    const detailed = picker.render(100).map(strip);

    expect(previewOf(compact).filter(Boolean)).toEqual([
      '   Thought for 3s, read 1 file, ran 1 command, edited 1 file +1 -1',
    ]);
    expect(previewOf(balanced).filter(Boolean)).toEqual([
      '   Thought for 3s, read 1 file',
      ' ● Edit src/app.ts · +1 -1',
      ' ● Bash npm test',
    ]);
    expect(previewOf(detailed).filter(Boolean)).toEqual([
      '   Thought for 3s, read 1 file',
      ' ● Used Edit (src/app.ts) · +1 -1',
      '   +1 -1 src/app.ts',
      '      1 - start()',
      '      1 + start(port = 3000)',
      ' ● Ran a command · $ npm test',
      '   12 tests passed',
    ]);
    expect(new Set([compact.length, balanced.length, detailed.length]).size).toBe(1);
    expect(detailed.at(-2)).toBe('');
    expect(detailed.at(-1)).toMatch(/^─+$/);
    picker.dispose();
  });

  it('previews folded thinking in the group title and unfolded thinking as two lines and a hint', () => {
    const picker = new ThinkingDisplaySelectorComponent({
      current: { toolCallDensity: 'balanced', thinking: 'grouped' },
      onSelect: () => {},
      onCancel: () => {},
    });
    const grouped = picker.render(100).map(strip);
    picker.handleInput(down);
    const ungrouped = picker.render(100).map(strip);

    expect(previewOf(grouped).filter(Boolean)).toEqual([
      '   Thought for 3s, read 1 file',
      ' ● Edit src/app.ts · +1 -1',
      ' ● Bash npm test',
    ]);
    expect(previewOf(ungrouped).filter(Boolean)).toEqual([
      ' ● Check how the app starts before changing it.',
      '   start() in src/app.ts takes no arguments, so the port is fixed.',
      '   … (2 more lines, ctrl+o to expand)',
      '   Read src/app.ts',
      ' ● Edit src/app.ts · +1 -1',
      ' ● Bash npm test',
    ]);
    expect(ungrouped).toHaveLength(grouped.length);
    picker.dispose();
  });

  it.each([120, 32])('keeps every preview line within a %i-column picker', (width) => {
    const pickers = [
      new ToolCallDensitySelectorComponent({
        current: { toolCallDensity: 'compact', thinking: 'ungrouped' },
        onSelect: () => {},
        onCancel: () => {},
      }),
      new ThinkingDisplaySelectorComponent({
        current: { toolCallDensity: 'detailed', thinking: 'grouped' },
        onSelect: () => {},
        onCancel: () => {},
      }),
    ];
    for (const picker of pickers) {
      for (let step = 0; step < 3; step++) {
        const rendered = picker.render(width);
        expect(rendered.map(strip)).toContain(' Preview');
        expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
        picker.handleInput(down);
      }
      picker.dispose();
    }
  });

  it('draws the previews without timers and releases them when the picker closes', () => {
    vi.useFakeTimers();
    const dispose = vi.spyOn(TranscriptContainer.prototype, 'dispose');
    onTestFinished(() => {
      dispose.mockRestore();
      vi.useRealTimers();
    });
    const picker = new ToolCallDensitySelectorComponent({
      current: { toolCallDensity: 'compact', thinking: 'grouped' },
      onSelect: () => {},
      onCancel: () => {},
    });
    picker.render(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(dispose).not.toHaveBeenCalled();

    picker.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});

describe('SettingsSelectorComponent mermaid entry', () => {
  it('offers Mermaid diagrams right after Theme', () => {
    const picker = new SettingsSelectorComponent({ onSelect: () => {}, onCancel: () => {} });
    const text = strip(picker.render(60).join('\n'));

    const themeIndex = text.indexOf('Theme');
    const mermaidIndex = text.indexOf('Mermaid diagrams');
    const editorIndex = text.indexOf('Editor');
    expect(mermaidIndex).toBeGreaterThan(themeIndex);
    expect(mermaidIndex).toBeLessThan(editorIndex);
  });
});
