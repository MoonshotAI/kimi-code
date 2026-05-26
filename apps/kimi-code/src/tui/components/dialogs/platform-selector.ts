import { OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

import type { ColorPalette } from '#/tui/theme/colors';

const PLATFORM_OPTIONS: readonly ChoiceOption[] = [
  { value: 'kimi-code', label: 'Kimi Code' },
  ...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })),
];

export interface PlatformSelectorOptions {
  readonly colors: ColorPalette;
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: 'Select a platform',
      options: [...PLATFORM_OPTIONS],
      colors: opts.colors,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
