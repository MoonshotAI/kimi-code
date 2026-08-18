import { createDecorator } from "#/_base/di/instantiation";

import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';

const SYSTEM_REMINDER_PREFIX = '<system-reminder>\n';
const SYSTEM_REMINDER_SUFFIX = '\n</system-reminder>';

export function wrapSystemReminder(content: string): string {
  return `${SYSTEM_REMINDER_PREFIX}${content.trim()}${SYSTEM_REMINDER_SUFFIX}`;
}

export function systemReminderContent(message: ContextMessage): string | undefined {
  const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  if (!text.startsWith(SYSTEM_REMINDER_PREFIX) || !text.endsWith(SYSTEM_REMINDER_SUFFIX)) {
    return undefined;
  }
  return text.slice(SYSTEM_REMINDER_PREFIX.length, text.length - SYSTEM_REMINDER_SUFFIX.length);
}

export interface IAgentSystemReminderService {
  readonly _serviceBrand: undefined;

  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;
}

export const IAgentSystemReminderService = createDecorator<IAgentSystemReminderService>('agentSystemReminderService');
