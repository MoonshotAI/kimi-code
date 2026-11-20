import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionManager, McpConnectionView } from '#/mcpCore/connection-manager';

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionView;
  isBaselineServer(name: string): boolean;
  readonly upsertTarget?: (name: string) => McpConnectionManager;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
