
import { createDecorator } from '@moonshot-ai/agent-core';
import type { WsConnection } from '#/ws/connection';

export interface ISessionClientsService {
  readonly _serviceBrand: undefined;

  subscribe(connection: WsConnection, sessionId: string): void;

  unsubscribe(connection: WsConnection, sessionId: string): void;

  getConnections(sessionId: string): Iterable<WsConnection>;

  forgetConnection(connection: WsConnection): void;

  subscriberCount(sessionId: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionClientsService = createDecorator<ISessionClientsService>(
  'sessionClientsService',
);
