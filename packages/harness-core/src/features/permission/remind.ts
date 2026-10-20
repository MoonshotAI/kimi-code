import {
  createHistoryMessageBuilder,
  type HistoryMessage,
  type UserEntry,
} from '@moonshot-ai/agent-core/history/index';
import type { ComputedRef } from '@moonshot-ai/agent-core/kernel/index';
import type { LoopHooks } from '@moonshot-ai/agent-core/loop/index';

import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';
import { PERMISSION_REMIND_KEY, type PermissionState } from './state/projection';
import type { PermissionMode } from './types';

export const PERMISSION_MODE_REMINDER_ENV = 'KIMI_CODE_PERMISSION_MODE_REMINDER';

const TRUE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export function permissionModeReminderEnabled(
  env: string | undefined = process.env[PERMISSION_MODE_REMINDER_ENV],
): boolean {
  return parseBooleanEnv(env) !== false;
}

export function createPermissionModeInjection(deps: {
  readonly state: ComputedRef<PermissionState>;
}): LoopHooks['step.starting'] {
  const { state } = deps;
  let lastMode: PermissionMode | undefined;

  const reminderEntry = (text: string): UserEntry => ({
    message: createHistoryMessageBuilder().systemReminder(text).userMessage(),
    meta: { source: 'reminder', key: PERMISSION_REMIND_KEY },
  });

  return ({ messages }) => {
    const currentMode = state.value.mode;
    const previousMode = lastMode;
    if (currentMode === previousMode) {
      if (currentMode !== 'auto') return;
      if (messages.some(isPermissionModeReminder)) return;
      return { messages: [...messages, reminderEntry(AUTO_MODE_ENTER_REMINDER)] };
    }
    lastMode = currentMode;
    if (currentMode === 'auto') {
      return { messages: [...messages, reminderEntry(AUTO_MODE_ENTER_REMINDER)] };
    }
    if (previousMode === 'auto') {
      return { messages: [...messages, reminderEntry(AUTO_MODE_EXIT_REMINDER)] };
    }
  };
}

function isPermissionModeReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === PERMISSION_REMIND_KEY;
}
