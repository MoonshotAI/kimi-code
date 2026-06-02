import { describe, expect, it, vi } from 'vitest';

import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { EditorSelectorComponent } from '#/tui/components/dialogs/editor-selector';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { darkColors } from '#/tui/theme/colors';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('ChoicePickerComponent', () => {
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
      colors: darkColors,
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
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(editor.render(120).map(strip)).toContain('  ❯ Vim ← current');

    const model = new ModelSelectorComponent({
      models: {
        kimi: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 200_000,
          displayName: 'Kimi K2',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'kimi',
      currentThinking: true,
      colors: darkColors,
      onSelect,
      onCancel,
    });
    const modelOutput = model.render(120).map(strip);
    expect(modelOutput).toContain('  ❯ Kimi K2 (Kimi Code) ← current');
    expect(modelOutput).toContain(' Thinking  (/ to toggle)');
    expect(modelOutput).toContain('  [ On ]    Off  ');

    const theme = new ThemeSelectorComponent({
      currentValue: 'light',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(theme.render(120).map(strip)).toContain('  ❯ Light ← current');

    const permission = new PermissionSelectorComponent({
      currentValue: 'manual',
      colors: darkColors,
      onSelect,
      onCancel,
    });
    expect(permission.render(120).map(strip)).toContain('  ❯ Manual ← current');

    const settings = new SettingsSelectorComponent({
      colors: darkColors,
      onSelect,
      onCancel,
    });
    const settingsOutput = settings.render(120).map(strip);
    expect(settingsOutput).toContain('  ❯ Model');
    expect(settingsOutput).toContain('    Switch the active model and thinking mode.');
  });

  it('submits the selected model and inline thinking state', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        kimi: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 200_000,
          displayName: 'Kimi K2',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'kimi',
      currentThinking: true,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('/');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'kimi', thinking: false });
  });

  it('forces always-thinking models on and unsupported models off', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        always: {
          provider: 'managed:kimi-code',
          model: 'kimi-thinking',
          maxContextSize: 200_000,
          displayName: 'Kimi Thinking',
          capabilities: ['always_thinking'],
        },
        plain: {
          provider: 'managed:kimi-code',
          model: 'kimi-plain',
          maxContextSize: 200_000,
          displayName: 'Kimi Plain',
          capabilities: ['tool_use'],
        },
      },
      currentValue: 'always',
      currentThinking: false,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    expect(picker.render(120).map(strip)).toContain('  [ Always on ]');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'always', thinking: true });

    picker.handleInput('\u001B[B');
    expect(picker.render(120).map(strip)).toContain('  [ Off ] unsupported');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith({ alias: 'plain', thinking: false });
  });

  it('keeps the thinking draft when moving across models', () => {
    const onSelect = vi.fn();
    const picker = new ModelSelectorComponent({
      models: {
        plain: {
          provider: 'managed:kimi-code',
          model: 'kimi-plain',
          maxContextSize: 200_000,
          displayName: 'Kimi Plain',
          capabilities: ['tool_use'],
        },
        thinking: {
          provider: 'managed:kimi-code',
          model: 'kimi-thinking',
          maxContextSize: 200_000,
          displayName: 'Kimi Thinking',
          capabilities: ['thinking'],
        },
      },
      currentValue: 'plain',
      currentThinking: false,
      colors: darkColors,
      onSelect,
      onCancel: vi.fn(),
    });

    picker.handleInput('\u001B[B');
    picker.handleInput('/');
    picker.handleInput('\u001B[A');
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith({ alias: 'thinking', thinking: true });
  });
});
