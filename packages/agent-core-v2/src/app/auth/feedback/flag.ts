import type { FlagDefinitionInput } from '#/app/flag/flagRegistry';

export const desktopFeedbackFlag = {
  id: 'desktop_feedback',
  env: 'KIMI_CODE_EXPERIMENTAL_DESKTOP_FEEDBACK',
  title: 'Desktop feedback',
  description: 'Enable global and reply feedback in the desktop app and web interface.',
  default: false,
  surface: 'core',
} satisfies FlagDefinitionInput;
