import type { ThinkingDisplay, ToolCallDensity, TranscriptConfig } from '../../config';
import type { DockLayout } from '../chrome/dock-section';
import { ChoicePickerComponent, PreviewChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { TranscriptPreview } from './transcript-preview';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'tuiMode'
  | 'toolCallDensity'
  | 'thinking'
  | 'copyOnSelect'
  | 'mermaid'
  | 'editor'
  | 'followUpBehavior'
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
    label: 'Tool call density',
    description: 'Choose how much of each tool call the transcript shows.',
  },
  {
    value: 'thinking',
    label: 'Thinking folding',
    description: 'Choose whether to fold finished thinking.',
  },
  {
    value: 'copyOnSelect',
    label: 'Copy on select',
    description: 'Choose whether selecting text in fullscreen mode copies it.',
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
    value: 'followUpBehavior',
    label: 'Follow-up behavior',
    description: 'Choose whether Enter queues or steers a message while Kimi is working.',
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
    value === 'copyOnSelect' ||
    value === 'mermaid' ||
    value === 'editor' ||
    value === 'followUpBehavior' ||
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
          (option.value !== 'toolCallDensity' &&
            option.value !== 'thinking' &&
            option.value !== 'copyOnSelect'),
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
    label: 'Fold thinking',
    description: 'Fold finished thinking into summary groups.',
  },
  {
    value: 'ungrouped',
    label: "Don't fold thinking",
    description: 'Show each thinking block as a two-line preview.',
  },
] as const satisfies readonly (ChoiceOption & { readonly value: ThinkingDisplay })[];

export interface TranscriptSettingSelectorOptions<V> {
  readonly current: TranscriptConfig;
  readonly layout?: DockLayout;
  readonly onSelect: (value: V) => void;
  readonly onCancel: () => void;
}

export class ToolCallDensitySelectorComponent extends PreviewChoicePickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<PickableToolCallDensity>) {
    super({
      title: 'Tool call density',
      options: TOOL_CALL_DENSITY_OPTIONS,
      currentValue: opts.current.toolCallDensity,
      onSelect: (value) => {
        const option = TOOL_CALL_DENSITY_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
      preview: new TranscriptPreview(new Map(TOOL_CALL_DENSITY_OPTIONS.map(
        (option) => [option.value, { ...opts.current, toolCallDensity: option.value }],
      ))),
      layout: opts.layout,
    });
  }
}

export class ThinkingDisplaySelectorComponent extends PreviewChoicePickerComponent {
  constructor(opts: TranscriptSettingSelectorOptions<ThinkingDisplay>) {
    super({
      title: 'Thinking folding',
      options: THINKING_OPTIONS,
      currentValue: opts.current.thinking,
      onSelect: (value) => {
        const option = THINKING_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
      preview: new TranscriptPreview(new Map(THINKING_OPTIONS.map(
        (option) => [option.value, { ...opts.current, thinking: option.value }],
      ))),
      layout: opts.layout,
    });
  }
}

const COPY_ON_SELECT_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: 'On',
    description: 'Copy text as soon as you select it.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Press Ctrl-C to copy selected text.',
  },
];

export interface CopyOnSelectSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class CopyOnSelectSelectorComponent extends ChoicePickerComponent {
  constructor(opts: CopyOnSelectSelectorOptions) {
    super({
      title: 'Copy on select',
      options: COPY_ON_SELECT_OPTIONS,
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        if (value === 'on' || value === 'off') opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
