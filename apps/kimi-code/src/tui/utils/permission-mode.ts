import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

export const PERMISSION_MODE_DISPLAY_NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: 'Always Ask',
  yolo: 'Ask When Needed',
  auto: 'Never Ask',
};
