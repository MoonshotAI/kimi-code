import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PASTE_BURST_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: 'On',
    description: 'Detect rapid non-bracketed paste bursts and avoid submitting them line by line.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Treat every Enter as a normal keypress, even during rapid paste-like input.',
  },
];

export interface PasteBurstSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class PasteBurstSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PasteBurstSelectorOptions) {
    super({
      title: 'Paste burst detection',
      options: [...PASTE_BURST_OPTIONS],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
