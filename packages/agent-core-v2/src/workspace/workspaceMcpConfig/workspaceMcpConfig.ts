import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

export type McpServersChangeEvent = McpServersChange & IWaitUntil;

export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface IWorkspaceMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;
}

export const IWorkspaceMcpConfigService: ServiceIdentifier<IWorkspaceMcpConfigService> =
  createDecorator<IWorkspaceMcpConfigService>('workspaceMcpConfigService');
