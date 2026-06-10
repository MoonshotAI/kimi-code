import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const EDITOR_OPTIONS: readonly ChoiceOption[] = [
  { value: 'code --wait', label: 'VS Code (code --wait)' },
  { value: 'vim', label: 'Vim' },
  { value: 'nvim', label: 'Neovim' },
  { value: 'nano', label: 'Nano' },
  { value: '', label: 'Auto-detect ($VISUAL / $EDITOR)' },
];

export interface EditorSelectorOptions {
  readonly currentValue: string;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class EditorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EditorSelectorOptions) {
    super({
      title: 'Select external editor',
      options: [...EDITOR_OPTIONS],
      currentValue: opts.currentValue,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
