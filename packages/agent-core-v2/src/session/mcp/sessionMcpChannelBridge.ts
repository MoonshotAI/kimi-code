/**
 * `mcp` domain (L5) — marker interface for `SessionMcpChannelBridgeImpl`.
 *
 * No public API: the service's only job is the side effect wired up in its
 * constructor (forwarding MCP channel notifications into the main agent's
 * prompt queue). Registered with `ScopeActivation.OnScopeCreated` so it's
 * instantiated eagerly per session even though nothing resolves it.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionMcpChannelBridge {
  readonly _serviceBrand: undefined;
}

export const ISessionMcpChannelBridge: ServiceIdentifier<ISessionMcpChannelBridge> =
  createDecorator<ISessionMcpChannelBridge>('sessionMcpChannelBridge');
