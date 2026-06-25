/**
 * `gateway` domain (L7) — scope registry and REST/WS gateways.
 *
 * Defines the public contracts of the gateway layer: the `IScopeRegistry` used
 * to create and look up sessions, plus the `IRestGateway` / `IWSGateway` /
 * `IWSBroadcastService` entry points. Core-scoped — shared across the
 * application.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';

export interface CreateSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
}

export interface IScopeRegistry {
  readonly _serviceBrand: undefined;
  createSession(opts: CreateSessionOptions): Promise<IScopeHandle>;
  get(sessionId: string): IScopeHandle | undefined;
  close(sessionId: string): Promise<void>;
}

export const IScopeRegistry: ServiceIdentifier<IScopeRegistry> =
  createDecorator<IScopeRegistry>('scopeRegistry');

export interface IRestGateway {
  readonly _serviceBrand: undefined;
  prompt(sessionId: string, agentId: string, input: string): Promise<void>;
  steer(sessionId: string, agentId: string, content: string): Promise<void>;
  cancel(sessionId: string, agentId: string, reason?: string): Promise<void>;
  getStatus(sessionId: string): Promise<unknown>;
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

export interface IWSBroadcastService {
  readonly _serviceBrand: undefined;
}

export const IWSBroadcastService: ServiceIdentifier<IWSBroadcastService> =
  createDecorator<IWSBroadcastService>('wsBroadcastService');
