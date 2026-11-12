/**
 * Inbox contract: queued user prompts (normal and notify) and reminders, what triggers a turn, and the
 * sources an appended message can come from.
 */
import type { Message, UserMessage } from '#/llm/message';

export type RemindMessage = Message;

export type QueuedItem =
  | { readonly kind: 'normal'; readonly message: UserMessage }
  | { readonly kind: 'notify'; readonly message: UserMessage }
  | { readonly kind: 'remind'; readonly message: RemindMessage };

export interface Inbox {
  normal: UserMessage[];
  notify: UserMessage[];
  remind: RemindMessage[];
}

export type TurnTrigger = 'normal' | 'notify' | 'continue';

export type MessageSource = QueuedItem['kind'] | 'llm' | 'tool' | 'partial';
