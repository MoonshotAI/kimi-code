/**
 * `gateway` domain (L7) — REST/WS gateways.
 *
 * Defines the public contracts of the gateway layer: the `IRestGateway` /
 * `IWSGateway` entry points. Session scope creation is owned by
 * `sessionLifecycle`; the gateway resolves sessions through it.
 * App-scoped — shared across the application.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IRestGateway {
  readonly _serviceBrand: undefined;

  prompt(
    sessionId: string,
    agentId: string,
    input: string,
  ): Promise<{ readonly turn_id: number } | undefined>;
  steer(
    sessionId: string,
    agentId: string,
    content: string,
  ): Promise<{ readonly turn_id: number } | undefined>;
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void>;
  getStatus(sessionId: string): Promise<unknown>;
  flushLogs(sessionId: string): Promise<void>;
  flushGlobalLogs(): Promise<void>;
}

export const IRestGateway: ServiceIdentifier<IRestGateway> =
  createDecorator<IRestGateway>('restGateway');

export interface IWSGateway {
  readonly _serviceBrand: undefined;

  connect(connectionId: string): void;
  broadcast(sessionId: string, event: unknown): void;
}

export const IWSGateway: ServiceIdentifier<IWSGateway> =
  createDecorator<IWSGateway>('wsGateway');
