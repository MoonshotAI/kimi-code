import type { ThinkingDisplay, ToolCallDensity } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'tuiMode'
  | 'toolCallDensity'
  | 'thinking'
  | 'mermaid'
  | 'editor'
  | 'permission'
  | 'survey'
  | 'experiments'
  | 'upgrade'
  | 'usage';

const SETTINGS_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'model',
    label: 'Model',
    description: 'Switch the active model and thinking mode.',
  },
  {
    value: 'permission',
    label: 'Permission',
    description: 'Choose how tool actions are approved.',
  },
  {
    value: 'theme',
    label: 'Theme',
    description: 'Change the terminal UI theme.',
  },
  {
    value: 'tuiMode',
    label: 'TUI mode',
    description: 'Choose the regular or fullscreen layout.',
  },
  {
    value: 'toolCallDensity',
    label: 'Tool calls',
    description: 'Choose how much of each tool call the transcript shows.',
  },
  {
    value: 'thinking',
    label: 'Thinking',
    description: 'Choose whether thinking folds into tool groups.',
  },
  {
    value: 'mermaid',
    label: 'Mermaid diagrams',
    description: 'Draw mermaid code blocks as diagrams, or keep them as source.',
  },
  {
    value: 'editor',
    label: 'Editor',
    description: 'Set the external editor command.',
  },
  {
    value: 'survey',
    label: 'Feedback survey',
    description: 'Turn the occasional session rating prompt on or off.',
  },
  {
    value: 'experiments',
    label: 'Experiments',
    description: 'Turn experimental features on or off.',
  },
  {
    value: 'upgrade',
    label: 'Automatic updates',
    description: 'Turn automatic CLI updates on or off.',
  },
  {
    value: 'usage',
    label: 'Usage',
    description: 'Show session tokens, context window, and plan quotas.',
  },
];

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'theme' ||
    value === 'tuiMode' ||
    value === 'toolCallDensity' ||
    value === 'thinking' ||
    value === 'mermaid' ||
    value === 'editor' ||
    value === 'permission' ||
    value === 'survey' ||
    value === 'experiments' ||
    value === 'upgrade' ||
    value === 'usage'
  );
}

export interface SettingsSelectorOptions {
  readonly fullscreen?: boolean;
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: 'Settings',
      options: SETTINGS_OPTIONS.filter(
        (option) =>
          opts.fullscreen === true ||
          (option.value !== 'toolCallDensity' && option.value !== 'thinking'),
      ),
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}

const TOOL_CALL_DENSITY_OPTIONS = [
  {
    value: 'compact',
    label: 'Compact',
    description: 'Fold tool calls into one summary. Subagents and questions stay as cards.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    description: 'Fold read-only calls. Edits and commands get one line each that you can open.',
  },
  {
    value: 'detailed',
    label: 'Detailed',
    description: 'Fold read-only calls. Edits and commands stay as full cards.',
  },
] as const satisfies readonly (ChoiceOption & { readonly value: ToolCallDensity })[];

const THINKING_OPTIONS = [
  {
    value: 'grouped',
    label: 'Grouped',
    description: 'Show thinking inside the group, with the latest line under the title.',
  },
  {
    value: 'ungrouped',
    label: 'Ungrouped',
    description: 'Show thinking as its own block.',
  },
] as const satisfies readonly (ChoiceOption & { readonly value: ThinkingDisplay })[];

export interface ToolCallDensitySelectorOptions {
  /** `ungrouped` is file-only: it has no row, so no row is marked current. */
  readonly currentValue: ToolCallDensity;
  readonly onSelect: (value: ToolCallDensity) => void;
  readonly onCancel: () => void;
}

export class ToolCallDensitySelectorComponent extends ChoicePickerComponent {
  constructor(opts: ToolCallDensitySelectorOptions) {
    super({
      title: 'Tool calls',
      options: TOOL_CALL_DENSITY_OPTIONS,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const option = TOOL_CALL_DENSITY_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
    });
  }
}

export interface ThinkingDisplaySelectorOptions {
  readonly currentValue: ThinkingDisplay;
  readonly onSelect: (value: ThinkingDisplay) => void;
  readonly onCancel: () => void;
}

export class ThinkingDisplaySelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThinkingDisplaySelectorOptions) {
    super({
      title: 'Thinking',
      options: THINKING_OPTIONS,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const option = THINKING_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
    });
  }
}
