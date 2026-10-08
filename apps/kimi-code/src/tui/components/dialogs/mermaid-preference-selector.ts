import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const MERMAID_PREFERENCE_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'on',
    label: 'On',
    description: 'Draw mermaid code blocks as diagrams in the terminal.',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Keep mermaid code blocks as highlighted source.',
  },
];

export interface MermaidPreferenceSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (value: boolean) => void;
  readonly onCancel: () => void;
}

export class MermaidPreferenceSelectorComponent extends ChoicePickerComponent {
  constructor(opts: MermaidPreferenceSelectorOptions) {
    super({
      title: 'Mermaid diagrams',
      options: [...MERMAID_PREFERENCE_OPTIONS],
      currentValue: opts.currentValue ? 'on' : 'off',
      onSelect: (value) => {
        opts.onSelect(value === 'on');
      },
      onCancel: opts.onCancel,
    });
  }
}
