import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

export interface ContextInjectionContext<D = unknown> {
  readonly injectedPositions: readonly number[];
  readonly lastInjectedAt: number | null;
  readonly lastInjection?: ContextMessage;
  readonly lastDisclosure?: D;
  readonly isNewTurn: boolean;
}

export interface ContextInjectionMessage {
  readonly role: 'user' | 'system';
  readonly content: readonly ContentPart[];
  readonly tools?: readonly Tool[];
}

export type ContextInjectionContent =
  | string
  | readonly ContentPart[]
  | { readonly message: ContextInjectionMessage };

export interface ContextInjectionResult<D = unknown> {
  readonly content: ContextInjectionContent;
  readonly disclosure?: D;
}

export type ContextInjectionProvider<D = unknown> = (
  context: ContextInjectionContext<D>,
) =>
  | ContextInjectionContent
  | ContextInjectionResult<D>
  | undefined
  | Promise<ContextInjectionContent | ContextInjectionResult<D> | undefined>;

export interface ReminderRegistration extends IDisposable {}

export interface ReminderNotification {
  readonly variant: string;
  readonly ownerPromptId?: string;
}
