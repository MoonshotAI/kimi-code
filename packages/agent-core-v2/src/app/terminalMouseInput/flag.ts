import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TERMINAL_MOUSE_INPUT_FLAG_ID = 'terminal_mouse_input';
export const TERMINAL_MOUSE_INPUT_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_TERMINAL_MOUSE_INPUT';

export const terminalMouseInputFlag: FlagDefinitionInput = {
  id: TERMINAL_MOUSE_INPUT_FLAG_ID,
  title: 'Terminal mouse input',
  description: 'Allow mouse clicks and drags to position and select text in the main prompt editor.',
  env: TERMINAL_MOUSE_INPUT_FLAG_ENV,
  default: false,
  surface: 'tui',
};

registerFlagDefinition(terminalMouseInputFlag);
