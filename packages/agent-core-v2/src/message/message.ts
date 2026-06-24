/**
 * `message` domain (L4) — protocol message projection over context.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProtocolMessage {
  readonly id: string;
  readonly role: string;
  readonly content: unknown;
}

export interface IMessageService {
  readonly _serviceBrand: undefined;
  list(): readonly ProtocolMessage[];
  get(id: string): ProtocolMessage | undefined;
}

export const IMessageService: ServiceIdentifier<IMessageService> =
  createDecorator<IMessageService>('messageService');
