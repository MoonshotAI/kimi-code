/**
 * Inbox contract: queued user prompts (normal and notify) and reminders, what triggers a turn, and the
 * sources an appended message can come from.
 */
import type { HistoryMessage, UserEntry } from '#/llm/history';

export type RemindEntry = HistoryMessage;

export type QueuedItem =
  | { readonly kind: 'normal'; readonly entry: UserEntry }
  | { readonly kind: 'notify'; readonly entry: UserEntry }
  | { readonly kind: 'remind'; readonly entry: RemindEntry };

export interface Inbox {
  normal: UserEntry[];
  notify: UserEntry[];
  remind: RemindEntry[];
}

export type TurnTrigger = 'normal' | 'notify' | 'continue';

export type MessageSource = QueuedItem['kind'] | 'llm' | 'tool' | 'partial';
