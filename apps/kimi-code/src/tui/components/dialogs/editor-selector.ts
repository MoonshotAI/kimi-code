import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';
import { t } from '#/i18n';

function getEditorOptions(): readonly ChoiceOption[] {
  return [
    { value: 'code --wait', label: t('tui.dialogs.editorSelector.vsCode') },
    { value: 'vim', label: t('tui.dialogs.editorSelector.vim') },
    { value: 'nvim', label: t('tui.dialogs.editorSelector.neovim') },
    { value: 'nano', label: t('tui.dialogs.editorSelector.nano') },
    { value: '', label: t('tui.dialogs.editorSelector.autoDetect') },
  ];
}

export interface EditorSelectorOptions {
  readonly currentValue: string;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class EditorSelectorComponent extends ChoicePickerComponent {
  constructor(opts: EditorSelectorOptions) {
    super({
      title: t('tui.dialogs.editorSelector.title'),
      options: [...getEditorOptions()],
      currentValue: opts.currentValue,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}