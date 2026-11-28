import type {
  SelectionCopyMode,
  ThinkingDisplay,
  ToolCallDensity,
  TranscriptConfig,
  WheelScrollLines,
} from '../../config';
import type { DockLayout } from '../chrome/dock-section';
import { ChoicePickerComponent, PreviewChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { TranscriptPreview } from './transcript-preview';

const SETTINGS_OPTIONS = [
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
    fullscreenOnly: true,
  },
  {
    value: 'thinking',
    label: 'Thinking folding',
    description: 'Choose whether to fold finished thinking.',
    fullscreenOnly: true,
  },
  {
    value: 'copyOnSelect',
    label: 'Selection copying',
    description: 'Choose when selected text is copied in fullscreen mode.',
    fullscreenOnly: true,
  },
  {
    value: 'scrollSpeed',
    label: 'Scroll speed',
    description: 'Choose how many lines the mouse wheel scrolls in fullscreen mode.',
    fullscreenOnly: true,
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
    description: 'Choose whether to queue follow-ups or steer the current turn.',
  },
  {
    value: 'survey',
    label: 'Feedback survey',
    description: 'Turn the occasional session rating prompt on or off.',
  },
  {
    value: 'experiments',
    label: 'Lab',
    description: 'Turn Beta and Experimental features on or off.',
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
] as const satisfies readonly (ChoiceOption & { readonly fullscreenOnly?: true })[];

export type SettingsSelection = (typeof SETTINGS_OPTIONS)[number]['value'];

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
        (option) => opts.fullscreen === true || !('fullscreenOnly' in option),
      ),
      onSelect: (value) => {
        const matched = SETTINGS_OPTIONS.find((option) => option.value === value);
        if (matched !== undefined) opts.onSelect(matched.value);
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

const SELECTION_COPY_MODE_OPTIONS = [
  {
    value: 'off',
    label: 'Off',
    description: 'Press Ctrl-C to copy selected text.',
  },
  {
    value: 'immediate',
    label: 'Immediately',
    description: 'Copy text as soon as you select it.',
  },
  {
    value: 'right-click',
    label: 'Right-click',
    description: 'Right-click to copy; right-click again to paste if clipboard reading is available.',
  },
] as const satisfies readonly (ChoiceOption & { readonly value: SelectionCopyMode })[];

export interface SelectionCopyModeSelectorOptions {
  readonly currentValue: SelectionCopyMode;
  readonly onSelect: (value: SelectionCopyMode) => void;
  readonly onCancel: () => void;
}

export class SelectionCopyModeSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SelectionCopyModeSelectorOptions) {
    super({
      title: 'Selection copying',
      options: SELECTION_COPY_MODE_OPTIONS,
      currentValue: opts.currentValue,
      onSelect: (value) => {
        const option = SELECTION_COPY_MODE_OPTIONS.find((candidate) => candidate.value === value);
        if (option !== undefined) opts.onSelect(option.value);
      },
      onCancel: opts.onCancel,
    });
  }
}

export const WHEEL_SCROLL_PRESETS = [
  'auto',
  1,
  2,
  3,
  5,
  10,
] as const satisfies readonly WheelScrollLines[];

export function formatWheelScrollSpeedLabel(value: WheelScrollLines): string {
  if (value === 'auto') return 'Auto';
  return value === 1 ? '1 line' : `${String(value)} lines`;
}

export interface ScrollSpeedSelectorOptions {
  readonly currentValue: WheelScrollLines;
  readonly onSelect: (value: WheelScrollLines) => void;
  readonly onCancel: () => void;
}

interface ScrollSpeedChoiceOption extends ChoiceOption {
  readonly lines: WheelScrollLines;
}

function buildScrollSpeedOptions(
  currentValue: WheelScrollLines,
): readonly ScrollSpeedChoiceOption[] {
  const options: ScrollSpeedChoiceOption[] = WHEEL_SCROLL_PRESETS.map((lines) => ({
    value: String(lines),
    lines,
    label: formatWheelScrollSpeedLabel(lines),
    ...(lines === 'auto'
      ? { description: 'Automatically speed up when scrolling fast.' }
      : {}),
  }));
  if (!WHEEL_SCROLL_PRESETS.some((preset) => preset === currentValue)) {
    options.push({
      value: String(currentValue),
      lines: currentValue,
      label: `${formatWheelScrollSpeedLabel(currentValue)} (custom)`,
      description: 'Custom value from tui.toml.',
    });
  }
  return options;
}

export class ScrollSpeedSelectorComponent extends ChoicePickerComponent {
  constructor(opts: ScrollSpeedSelectorOptions) {
    const options = buildScrollSpeedOptions(opts.currentValue);
    super({
      title: 'Scroll speed',
      options,
      currentValue: String(opts.currentValue),
      onSelect: (value) => {
        const matched = options.find((option) => option.value === value);
        if (matched !== undefined) opts.onSelect(matched.lines);
      },
      onCancel: opts.onCancel,
    });
  }
}
