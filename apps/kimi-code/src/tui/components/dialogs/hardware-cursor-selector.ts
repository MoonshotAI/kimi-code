import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const HARDWARE_CURSOR_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: 'On',
    description: 'Show the terminal cursor for IME candidate positioning.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Keep only the styled editor cursor visible.',
  },
];

export interface HardwareCursorSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class HardwareCursorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: HardwareCursorSelectorOptions) {
    super({
      title: 'Hardware cursor',
      options: [...HARDWARE_CURSOR_OPTIONS],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
