import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

/** Thinking effort levels exposed to the user, in ascending order. */
export const THINKING_EFFORT_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingEffortLevel = (typeof THINKING_EFFORT_LEVELS)[number];

export function isThinkingEffortLevel(value: string): value is ThinkingEffortLevel {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(value);
}

const EFFORT_OPTIONS: readonly ChoiceOption[] = [
  { value: 'off', label: 'Off', description: 'Disable extended thinking — respond directly.' },
  { value: 'low', label: 'Low', description: 'Brief reasoning before responding.' },
  { value: 'medium', label: 'Medium', description: 'Moderate reasoning for everyday tasks.' },
  { value: 'high', label: 'High', description: 'Thorough reasoning. Recommended default.' },
  {
    value: 'xhigh',
    label: 'Extra high',
    description: 'Extended reasoning. Provider/model-specific; clamps to high when unsupported.',
  },
  {
    value: 'max',
    label: 'Max',
    description: 'Maximum reasoning. Provider/model-specific; clamps to high when unsupported.',
  },
];

export interface EffortSelectorOptions {
  readonly currentValue: string;
  readonly colors: ColorPalette;
  readonly onSelect: (level: ThinkingEffortLevel) => void;
  readonly onCancel: () => void;
}

export class EffortSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EffortSelectorOptions) {
    super({
      title: 'Set thinking effort',
      options: [...EFFORT_OPTIONS],
      currentValue: opts.currentValue,
      colors: opts.colors,
      onSelect: (value) => {
        if (isThinkingEffortLevel(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
