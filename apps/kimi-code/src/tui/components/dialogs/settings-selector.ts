import type { ThinkingDisplay, ToolCallDensity, TranscriptConfig } from '../../config';
import { ChoicePickerComponent, type ChoiceOption, type ChoicePickerOptions } from './choice-picker';
import { TranscriptPreview } from './transcript-preview';

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

type PickableToolCallDensity = Exclude<ToolCallDensity, 'ungrouped'>;

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
] as const satisfies readonly (ChoiceOption & { readonly value: PickableToolCallDensity })[];

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

export interface TranscriptSettingSelectorOptions<V> {
  readonly current: TranscriptConfig;
  readonly getAvailableRows?: () => number;
  readonly onSelect: (value: V) => void;
  readonly onCancel: () => void;
}

class TranscriptSettingPickerComponent extends ChoicePickerComponent {
  constructor(
    opts: Omit<ChoicePickerOptions, 'preview'>,
    private readonly preview: TranscriptPreview,
  ) {
    super({ ...opts, preview: (value, width) => preview.render(value, width) });
  }

  override invalidate(): void {
    this.preview.invalidate();
  }

  dispose(): void {
    this.preview.dispose();
  }
}

export class ToolCallDensitySelectorComponent extends TranscriptSettingPickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<PickableToolCallDensity>) {
    super(
      {
        title: 'Tool calls',
        options: TOOL_CALL_DENSITY_OPTIONS,
        currentValue: opts.current.toolCallDensity,
        getAvailableRows: opts.getAvailableRows,
        onSelect: (value) => {
          const option = TOOL_CALL_DENSITY_OPTIONS.find((candidate) => candidate.value === value);
          if (option !== undefined) opts.onSelect(option.value);
        },
        onCancel: opts.onCancel,
      },
      new TranscriptPreview(new Map(TOOL_CALL_DENSITY_OPTIONS.map(
        (option) => [option.value, { ...opts.current, toolCallDensity: option.value }],
      ))),
    );
  }
}

export class ThinkingDisplaySelectorComponent extends TranscriptSettingPickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<ThinkingDisplay>) {
    super(
      {
        title: 'Thinking',
        options: THINKING_OPTIONS,
        currentValue: opts.current.thinking,
        getAvailableRows: opts.getAvailableRows,
        onSelect: (value) => {
          const option = THINKING_OPTIONS.find((candidate) => candidate.value === value);
          if (option !== undefined) opts.onSelect(option.value);
        },
        onCancel: opts.onCancel,
      },
      new TranscriptPreview(new Map(THINKING_OPTIONS.map(
        (option) => [option.value, { ...opts.current, thinking: option.value }],
      ))),
    );
  }
}
