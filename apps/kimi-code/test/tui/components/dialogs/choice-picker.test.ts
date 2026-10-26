import { stripVTControlCharacters } from 'node:util';

import { visibleWidth, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ChoicePickerComponent, type ChoiceOption } from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '#/tui/components/dialogs/update-preference-selector';
import { currentTheme } from '#/tui/theme';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function mouse(
  type: 'move' | 'press' | 'release' | 'click' | 'wheel',
  y: number,
  wheelDelta?: number,
): TuiMouseEvent {
  return {
    type,
    button: type === 'move' || type === 'wheel' ? 'none' : 'left',
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

function useMouseClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

describe('ChoicePickerComponent', () => {
  it('keeps ordinary notices as plain text', () => {
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      notice: '**Plain notice**',
      options: [{ value: 'keep', label: 'Keep current' }],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(picker.render(100).map(strip)).toContain(' **Plain notice**');
  });

  it.each([24, 100])('renders Markdown notices and preserves paragraphs at width %s', (width) => {
    const picker = new ChoicePickerComponent({
      title: 'Migration',
      notice: { markdown: '### Upgrade\n\nUse **next** model.\n\n- Faster replies\n- [Details](https://example.com/upgrade)' },
      options: [{ value: 'keep', label: 'Keep current' }],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = picker.render(width);
    const lines = rendered.map(stripVTControlCharacters);
    const output = lines.join('\n');
    expect(output).toContain(' Upgrade');
    expect(output).toContain(' Use next model.');
    expect(output).toContain('Faster replies');
    expect(output).toContain('Details');
    expect(output).not.toContain('###');
    expect(output).not.toContain('**');
    expect(output).not.toContain('[Details]');
    const paragraph = lines.findIndex((line) => line.includes('Use next model.'));
    expect(lines[paragraph - 1]?.trim()).toBe('');
    expect(lines[paragraph + 1]?.trim()).toBe('');
    expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it('uses the model-dialog header vocabulary (capitalized keys, "type to search")', () => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      searchable: true,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);

    const titleIdx = lines.findIndex((l) => l.includes('Add provider'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // Title carries the same "(type to search)" suffix as /model and /provider.
    expect(lines[titleIdx]).toContain('(type to search)');
    expect(lines[titleIdx]).not.toContain('type to filter');
    // Hint sits directly under the title and uses lowercase key vocabulary.
    const hint = lines[titleIdx + 1];
    expect(hint).toContain('↑↓ navigate');
    expect(hint).toContain('Enter select');
    expect(hint).toContain('Esc cancel');
    expect(hint).not.toContain('enter select');
    expect(hint).not.toContain('esc cancel');
    // Blank line separates the hint from the body, like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
  });

  it('renders optional descriptions below choice labels', () => {
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        {
          value: 'manual',
          label: 'Manual',
          description: 'Ask before commands, edits, and other risky actions.',
        },
        {
          value: 'auto',
          label: 'Auto',
          description: 'Automatically approve tool actions and plan transitions.',
        },
      ],
      currentValue: 'manual',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = picker.render(120).map(strip);

    expect(out).toContain('  ❯ Manual ← current');
    expect(out).toContain('    Ask before commands, edits, and other risky actions.');
    expect(out).toContain('    Automatically approve tool actions and plan transitions.');
  });

  it('renders domain selector wrappers with their configured options', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const editor = new EditorSelectorComponent({
      currentValue: 'vim',
      onSelect,
      onCancel,
    });
    expect(editor.render(120).map(strip)).toContain('  ❯ Vim ← current');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain('  ❯ Light ← current');

    const permission = new PermissionSelectorComponent({
      currentValue: 'manual',
      initialValue: 'yolo',
      onSelect,
      onCancel,
    });
    const permissionOutput = permission.render(120).map(strip);
    expect(permissionOutput).toContain('  ❯ Ask When Needed');
    expect(permissionOutput).toContain('    Always Ask ← current');

    const settings = new SettingsSelectorComponent({
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ Model');
    expect(settingsOutput).toContain('    Switch the active model and thinking mode.');
    expect(settingsOutput).toContain('    TUI mode');
    expect(settingsOutput).toContain('    Choose the regular or fullscreen layout.');

    const upgradePreference = new UpdatePreferenceSelectorComponent({
      currentValue: true,
      onSelect,
      onCancel,
    });
    const upgradePreferenceOutput = upgradePreference.render(120).map(strip);
    expect(upgradePreferenceOutput).toContain('  ❯ On ← current');
    expect(upgradePreferenceOutput).toContain('    Install new versions in the background.');
  });

  it('routes Space into the query for searchable lists instead of selecting', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Select a provider',
      options: [
        { value: 'openai', label: 'OpenAI' },
        { value: 'azure', label: 'Azure OpenAI' },
      ],
      searchable: true,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects on Space when the list is not searchable', () => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [{ value: 'a', label: 'Alpha' }],
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput(' ');
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it.each([' ', '\u001B[32u'])('requires Enter when spaceSelect is disabled (%j)', (space) => {
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Confirm migration',
      options: [{ value: 'switch', label: 'Switch model' }],
      spaceSelect: false,
      onSelect,
      onCancel: vi.fn(),
    });
    picker.handleInput(space);
    expect(onSelect).not.toHaveBeenCalled();
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('switch');
  });

  it('moves selection with the pointer and activates the same option on click', () => {
    useMouseClock();
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [
        { value: 'a', label: 'Alpha', description: 'First description' },
        { value: 'b', label: 'Beta', description: 'Second description' },
      ],
      currentValue: 'a',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.focused = true;
    const before = picker.render(80).map(strip);
    vi.advanceTimersByTime(300);
    const descriptionRow = before.findIndex((line) => line.includes('Second description'));

    expect(picker.handleMouse(mouse('move', descriptionRow))).toEqual({ handled: true, render: true });
    const hovered = picker.render(80).map(strip);
    expect(hovered).toContain('  ❯ Beta');
    expect(hovered.find((line) => line.includes('Alpha ← current'))).not.toContain('❯');
    expect(onSelect).not.toHaveBeenCalled();

    for (const type of ['press', 'release', 'click'] as const) picker.handleMouse(mouse(type, descriptionRow));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('uses the mouse wheel to turn existing pages', () => {
    const picker = new SettingsSelectorComponent({ onSelect: vi.fn(), onCancel: vi.fn() });
    picker.focused = true;
    picker.render(80);

    expect(picker.handleMouse(mouse('wheel', 5, 1))).toEqual({ handled: true, render: true });
    expect(picker.render(80).map(strip).join('\n')).toContain('Page 2/2');
    expect(picker.handleMouse(mouse('wheel', 5, -1))).toEqual({ handled: true, render: true });
    expect(picker.render(80).map(strip).join('\n')).toContain('Page 1/2');
  });

  it('fades while unfocused and makes the first click only take focus', () => {
    useMouseClock();
    const previousLevel = chalk.level;
    chalk.level = 3;
    onTestFinished(() => {
      chalk.level = previousLevel;
    });
    const onSelect = vi.fn();
    const picker = new ChoicePickerComponent({
      title: 'Pick one',
      options: [{ value: 'a', label: 'Alpha' }],
      onSelect,
      onCancel: vi.fn(),
    });
    picker.focused = true;
    const focused = picker.render(80);
    picker.focused = false;
    expect(picker.render(80)).toEqual(focused.map((line) => currentTheme.fade(line)));
    vi.advanceTimersByTime(300);
    const row = focused.map(strip).findIndex((line) => line.includes('Alpha'));

    expect(picker.handleMouse(mouse('click', row))).toEqual({ handled: true, focus: true });
    expect(onSelect).not.toHaveBeenCalled();

    picker.focused = true;
    for (const type of ['press', 'release', 'click'] as const) picker.handleMouse(mouse(type, row));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('renders the selected option description in descriptionTone, others in textMuted', () => {
    const options: ChoiceOption[] = [
      { value: 'none', label: 'No attachment', description: 'Text feedback only' },
      {
        value: 'logs+codebase',
        label: 'Logs + codebase',
        description: 'Include your codebase for deeper diagnosis.',
        descriptionTone: 'warning',
      },
    ];

    const renderDescLine = (currentValue: string): string | undefined => {
      const picker = new ChoicePickerComponent({
        title: 'Share diagnostic info?',
        options,
        currentValue,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      picker.focused = true;
      return picker.render(120).find((line) => strip(line).includes('Include your codebase'));
    };

    const warningLine = currentTheme.fg('warning', '    Include your codebase for deeper diagnosis.');
    const mutedLine = currentTheme.fg('textMuted', '    Include your codebase for deeper diagnosis.');

    // Selected option: description uses the configured tone.
    expect(renderDescLine('logs+codebase')).toBe(warningLine);
    // Unselected option: description falls back to textMuted.
    expect(renderDescLine('none')).toBe(mutedLine);
  });
});
