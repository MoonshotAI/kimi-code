/**
 * `message` domain (L4) — `IMessageService` implementation.
 *
 * Projects context history into protocol messages; reads history through
 * `context`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IContextService } from '#/context/context';

import { type ProtocolMessage, IMessageService } from './message';

function deriveId(index: number): string {
  return `msg-${index}`;
}

export class MessageService implements IMessageService {
  declare readonly _serviceBrand: undefined;

  constructor(@IContextService private readonly context: IContextService) {}

  list(): readonly ProtocolMessage[] {
    return this.context.project().map((m, i) => ({
      id: deriveId(i),
      role: m.role,
      content: m.content,
    }));
  }

  get(id: string): ProtocolMessage | undefined {
    return this.list().find((m) => m.id === id);
  }
}

registerScopedService(LifecycleScope.Agent, IMessageService, MessageService, InstantiationType.Delayed, 'message');
