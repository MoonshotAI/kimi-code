import { OPEN_PLATFORMS } from '@moonshot-ai/kimi-code-oauth';

import { currentKimiRegion, KIMI_CODE_OVERSEAS_PLATFORM_VALUE } from '#/utils/region';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const KIMI_CODE_CN_OPTION: ChoiceOption = { value: 'kimi-code', label: 'Kimi Code (kimi.com/code)' };
const KIMI_CODE_OVERSEAS_OPTION: ChoiceOption = {
  value: KIMI_CODE_OVERSEAS_PLATFORM_VALUE,
  label: 'Kimi Code (kimi.ai/code)',
};

function platformOptions(): readonly ChoiceOption[] {
  // The suggested region's entry goes first so it is the initial highlight.
  const oauthOptions =
    currentKimiRegion() === 'overseas'
      ? [KIMI_CODE_OVERSEAS_OPTION, KIMI_CODE_CN_OPTION]
      : [KIMI_CODE_CN_OPTION, KIMI_CODE_OVERSEAS_OPTION];
  return [
    ...oauthOptions,
    ...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })),
  ];
}

export interface PlatformSelectorOptions {
  readonly onSelect: (platformId: string) => void;
  readonly onCancel: () => void;
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: 'Select a platform',
      options: [...platformOptions()],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
