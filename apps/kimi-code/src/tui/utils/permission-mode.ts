import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

export const PERMISSION_MODE_DISPLAY_NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: 'Always Ask',
  yolo: 'Ask When Needed',
  auto: 'Never Ask',
};

export const PERMISSION_MODE_DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  manual: 'Auto-read only; everything else needs your approval first.',
  yolo: 'Routine edits and commands run automatically; risky actions, questions, and plans still ask.',
  auto: 'Everything runs and is decided automatically; only plans in Plan mode wait for your review.',
};
