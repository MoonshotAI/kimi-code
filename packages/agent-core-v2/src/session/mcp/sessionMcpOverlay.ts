import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export const SESSION_MCP_OVERLAY_STARTUP_TIMEOUT_MS = 5_000;

export interface ISessionMcpOverlayConnection {
  readonly ready: Promise<void>;
  shutdown(): Promise<void>;
}

export const ISessionMcpOverlayConnection: ServiceIdentifier<ISessionMcpOverlayConnection> =
  createDecorator<ISessionMcpOverlayConnection>('sessionMcpOverlayConnection');

export const inactiveSessionMcpOverlayConnection: ISessionMcpOverlayConnection = {
  ready: Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

export function sessionMcpOverlayConnectionSeed(
  connection: ISessionMcpOverlayConnection,
): ScopeSeed {
  return [[ISessionMcpOverlayConnection as ServiceIdentifier<unknown>, connection]];
}
