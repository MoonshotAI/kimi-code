import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TUI_TABS_FLAG_ID = 'tui_tabs';
export const TUI_TABS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TUI_TABS';

export const tuiTabsFlag: FlagDefinitionInput = {
  id: TUI_TABS_FLAG_ID,
  title: 'TUI session tabs',
  description:
    'Keep several sessions alive in one TUI and switch between them as tabs (/tab, /new tab, Alt+1..9).',
  env: TUI_TABS_FLAG_ENV,
  default: false,
  surface: 'tui',
};

registerFlagDefinition(tuiTabsFlag);
