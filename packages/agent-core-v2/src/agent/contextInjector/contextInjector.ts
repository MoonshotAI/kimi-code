import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";
import type { ContentPart } from "#/kosong/contract/message";
import type { Tool } from "#/kosong/contract/tool";
import type { ContextMessage } from '#/agent/contextMemory/types';

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

export interface IAgentContextInjectorService {
  readonly _serviceBrand: undefined;

  register<D = unknown>(
    name: string,
    provider: ContextInjectionProvider<D>,
  ): IDisposable;

  reconcileWhenIdle(name: string): Promise<void>;
}

export const IAgentContextInjectorService = createDecorator<IAgentContextInjectorService>(
  'agentContextInjectorService',
);
