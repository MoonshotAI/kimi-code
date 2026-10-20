import type { SystemEntry, UserEntry } from '#/history/message';

export type RemindEntry = SystemEntry | UserEntry;

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

export type MessageSource = QueuedItem['kind'] | 'llm' | 'tool';
