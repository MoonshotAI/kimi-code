import type { ViewMessage, ViewPart, ViewRole } from '#/model/types';

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

export function withoutReminders(text: string): string {
  return text.replace(REMINDER, '').trim();
}

export function remindersIn(text: string): string[] {
  return [...text.matchAll(REMINDER)].map((match) => (match[1] ?? '').trim());
}

export function textOfParts(parts: readonly ViewPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

export function textsOf(messages: readonly ViewMessage[], role: ViewRole): string[] {
  return messages.filter((message) => message.role === role).map((message) => message.text);
}

export function firstUserText(messages: readonly ViewMessage[]): string {
  return withoutReminders(messages.find((message) => message.role === 'user')?.text ?? '');
}

export function userTextsSinceReply(messages: readonly ViewMessage[]): string[] {
  return userMessagesSinceReply(messages)
    .map((message) => withoutReminders(message.text))
    .filter((text) => text !== '');
}

export function remindersSinceReply(messages: readonly ViewMessage[]): string[] {
  return userMessagesSinceReply(messages).flatMap((message) => remindersIn(message.text));
}

function userMessagesSinceReply(messages: readonly ViewMessage[]): ViewMessage[] {
  const lastReply = messages.findLastIndex((message) => message.role === 'assistant');
  return messages.slice(lastReply + 1).filter((message) => message.role === 'user');
}
