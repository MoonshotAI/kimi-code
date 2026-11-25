import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';

export type McpDirs = Pick<IWorkspaceDirs, 'ready' | 'primary' | 'onDidChange'>;

export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

export type McpServersChangeEvent = McpServersChange & IWaitUntil;

export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly defaultDeferred?: boolean;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

export interface IWorkspaceMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;

  readonly onDidChangeTunables: Event<McpTunables>;
}

export const IWorkspaceMcpConfigService: ServiceIdentifier<IWorkspaceMcpConfigService> =
  createDecorator<IWorkspaceMcpConfigService>('workspaceMcpConfigService');
