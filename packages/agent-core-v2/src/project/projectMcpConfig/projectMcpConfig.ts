import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';

export type McpDirs = Pick<IProjectDirs, 'ready' | 'primary' | 'onDidChange'>;

export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

export type McpServersChangeEvent = McpServersChange & IWaitUntil;

export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly startupWaitMs?: number;
  readonly toolTimeoutMs?: number;
  readonly defaultDeferred?: boolean;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

export interface IProjectMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;

  readonly onDidChangeTunables: Event<McpTunables>;
}

export const IProjectMcpConfigService: ServiceIdentifier<IProjectMcpConfigService> =
  createDecorator<IProjectMcpConfigService>('workspaceMcpConfigService');
