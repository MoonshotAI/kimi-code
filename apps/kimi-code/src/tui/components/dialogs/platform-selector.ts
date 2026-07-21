import { OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth';

import { flags } from '#/flags';
import { t } from '#/i18n';
import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: 'kimi-code', label: t('tui.dialogs.platformSelector.kimiCode') },
  ...OPEN_PLATFORMS
    .filter((p) => p.id !== 'astron' || flags.enabled('xunfei_coding_plan'))
    .map((platform) => ({ value: platform.id, label: platform.name })),
];

export interface PlatformSelectorOptions {
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: t('tui.dialogs.platformSelector.title'),
      options: [...PLATFORM_OPTIONS],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
