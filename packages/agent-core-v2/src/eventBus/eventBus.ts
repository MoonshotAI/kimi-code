import type { AgentEvent as ProtocolAgentEvent } from '@moonshot-ai/protocol';

import { createDecorator } from "#/_base/di";
import type { IDisposable } from "#/_base/di";

export interface IEventBus {
  emit(event: ProtocolAgentEvent): void;
  on(handler: (event: ProtocolAgentEvent) => void): IDisposable;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventBus = createDecorator<IEventBus>('agentEventBusService');
