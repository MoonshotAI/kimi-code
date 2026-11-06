import type { TranscriptGroupTools } from '../../config';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'tuiMode'
  | 'groupTools'
  | 'groupThinking'
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
    value: 'groupTools',
    label: 'Tool call folding',
    description: 'Choose which tool calls to fold into summary groups.',
  },
  {
    value: 'groupThinking',
    label: 'Thinking folding',
    description: 'Choose whether to fold finished thinking.',
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
    value === 'groupTools' ||
    value === 'groupThinking' ||
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
          (option.value !== 'groupTools' && option.value !== 'groupThinking'),
      ),
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}

const GROUP_TOOLS_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'auto',
    label: 'Fold most tools',
    description: 'Fold all tools except subagents and communication tools.',
  },
  {
    value: 'explore',
    label: 'Fold read-only tools',
    description: 'Fold reads, searches, and other read-only commands.',
  },
  {
    value: 'off',
    label: 'Show every tool call separately',
    description: 'Keep each tool call as its own card.',
  },
];

const GROUP_THINKING_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: 'Fold thinking',
    description: 'Fold finished thinking into summary groups.',
  },
  {
    value: 'off',
    label: "Don't fold thinking",
    description: 'Show each thinking block as a two-line preview.',
  },
];

export interface TranscriptGroupToolsSelectorOptions {
  readonly currentValue: TranscriptGroupTools;
  readonly onSelect: (value: TranscriptGroupTools) => void;
  readonly onCancel: () => void;
}

export class TranscriptGroupToolsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: TranscriptGroupToolsSelectorOptions) {
    super({
      title: 'Tool call folding',
      options: GROUP_TOOLS_OPTIONS,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        if (value === 'auto' || value === 'explore' || value === 'off') opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}

export interface TranscriptGroupThinkingSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class TranscriptGroupThinkingSelectorComponent extends ChoicePickerComponent {
  constructor(opts: TranscriptGroupThinkingSelectorOptions) {
    super({
      title: 'Thinking folding',
      options: GROUP_THINKING_OPTIONS,
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        if (value === 'on' || value === 'off') opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
