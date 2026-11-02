import { describe, expect, it, vi } from 'vitest';

import { MermaidPreferenceSelectorComponent } from '#/tui/components/dialogs/mermaid-preference-selector';
import {
  SettingsSelectorComponent,
  TranscriptGroupThinkingSelectorComponent,
  TranscriptGroupToolsSelectorComponent,
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
  it('lists the transcript grouping settings only in fullscreen', () => {
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
    expect(regular).not.toContain('Tool grouping');
    expect(regular).not.toContain('Group thinking');

    const fullscreen = settingsText(true);
    expect(fullscreen).toContain('Tool grouping');
    expect(fullscreen).toContain('Choose which tool calls to fold. Fullscreen only.');
    expect(fullscreen).toContain('Group thinking');
    expect(fullscreen).toContain('Include thinking in transcript groups. Fullscreen only.');
  });

  it('selects tool grouping and thinking values with current markers', () => {
    const onGroupTools = vi.fn();
    const groupTools = new TranscriptGroupToolsSelectorComponent({
      currentValue: 'auto',
      onSelect: onGroupTools,
      onCancel: () => {},
    });
    expect(strip(groupTools.render(90).join('\n'))).toContain('Auto ← current');
    groupTools.handleInput('\r');
    expect(onGroupTools).toHaveBeenCalledWith('auto');

    const onThinking = vi.fn();
    const thinking = new TranscriptGroupThinkingSelectorComponent({
      currentValue: true,
      onSelect: onThinking,
      onCancel: () => {},
    });
    const text = strip(thinking.render(100).join('\n'));
    expect(text).toContain('On ← current');
    expect(text).toContain('Include finished thinking in transcript groups.');
    thinking.handleInput('\r');
    expect(onThinking).toHaveBeenCalledWith(true);
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
