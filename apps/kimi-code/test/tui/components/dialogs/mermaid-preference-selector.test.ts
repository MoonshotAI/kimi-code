import { describe, expect, it, vi } from 'vitest';

import { MermaidPreferenceSelectorComponent } from '#/tui/components/dialogs/mermaid-preference-selector';
import {
  SettingsSelectorComponent,
  ThinkingDisplaySelectorComponent,
  ToolCallDensitySelectorComponent,
} from '#/tui/components/dialogs/settings-selector';

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
    expect(regular).not.toContain('Tool calls');
    expect(regular).not.toContain('Choose whether thinking folds into tool groups.');

    const fullscreen = settingsText(true);
    expect(fullscreen).toContain('Tool calls');
    expect(fullscreen).toContain('Choose how much of each tool call the transcript shows.');
    expect(fullscreen).toContain('Thinking');
    expect(fullscreen).toContain('Choose whether thinking folds into tool groups.');
    expect(fullscreen).not.toContain('Tool call folding');
    expect(fullscreen).not.toContain('Thinking folding');
  });

  it('offers compact, balanced, and detailed tool calls with the current marker', () => {
    const onSelect = vi.fn();
    const picker = new ToolCallDensitySelectorComponent({
      currentValue: 'balanced',
      onSelect,
      onCancel: () => {},
    });
    const lines = picker.render(100).map(strip);
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
      currentValue: 'ungrouped',
      onSelect,
      onCancel: () => {},
    });
    const text = strip(picker.render(100).join('\n'));
    expect(text).not.toContain('← current');
    expect(text).not.toMatch(/ungrouped/i);

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('compact');
  });

  it('offers grouped and ungrouped thinking with the current marker', () => {
    const onSelect = vi.fn();
    const picker = new ThinkingDisplaySelectorComponent({
      currentValue: 'grouped',
      onSelect,
      onCancel: () => {},
    });
    const lines = picker.render(100).map(strip);
    expect(lines).toContain('  ❯ Grouped ← current');
    expect(lines).toContain('    Show thinking inside the group, with the latest line under the title.');
    expect(lines).toContain('    Ungrouped');
    expect(lines).toContain('    Show thinking as its own block.');

    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('ungrouped');
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
