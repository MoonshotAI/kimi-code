import { useStepStarting, useToolPermitting } from '#/app/index';
import { useInject } from '#/composition-api/index';
import {
  createHistoryMessageBuilder,
  type HistoryMessage,
  type UserEntry,
} from '@moonshot-ai/agent-core/history/index';

import { PermissionRef } from '#/todo-features/permission/ref';
import type { PermissionMode } from '#/todo-features/permission/types';

import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

export const PERMISSION_REMIND_KEY = 'permission-mode';

export const PERMISSION_MODE_REMINDER_ENV = 'KIMI_CODE_PERMISSION_MODE_REMINDER';

export const AUTO_MODE_ASK_USER_QUESTION_DISABLED =
  'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.';

const TRUE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export function permissionModeReminderEnabled(env: string | undefined): boolean {
  return parseBooleanEnv(env) !== false;
}

function reminderEntry(text: string): UserEntry {
  return {
    message: createHistoryMessageBuilder().systemReminder(text).userMessage(),
    meta: { source: 'reminder', key: PERMISSION_REMIND_KEY },
  };
}

function isPermissionModeReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === PERMISSION_REMIND_KEY;
}

export function useAskUserQuestionAutoMode(reminderEnabled: boolean): void {
  const permission = useInject(PermissionRef);
  if (reminderEnabled) {
    let lastMode: PermissionMode | undefined;
    useStepStarting(({ messages }) => {
      const currentMode = permission.value?.state.value.mode;
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
    });
  }
  useToolPermitting(({ toolCall }) => {
    if (permission.value?.state.value.mode !== 'auto') return undefined;
    if (toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      blocked: { reason: 'denied', message: AUTO_MODE_ASK_USER_QUESTION_DISABLED },
      result: { content: [{ type: 'text', text: AUTO_MODE_ASK_USER_QUESTION_DISABLED }] },
    };
  });
}
