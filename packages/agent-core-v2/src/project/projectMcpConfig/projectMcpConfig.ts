import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { McpTunables } from '#/app/mcpConfig/configSection';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpServerConfigEntry } from '#/mcpCore/config-override';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';

export type { McpTunables };

export type McpDirs = Pick<IProjectDirs, 'ready' | 'primary' | 'onDidChange'>;

export type McpProjectSourceId = 'plugin' | 'user' | 'project-root' | 'workspace';

export const MCP_PROJECT_SOURCE_IDS: readonly McpProjectSourceId[] = [
  'plugin',
  'user',
  'project-root',
  'workspace',
];

export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

export type McpServersChangeEvent = McpServersChange & IWaitUntil;

export interface McpSourceServersChange {
  readonly sourceId: McpProjectSourceId;
  readonly upsert: Readonly<Record<string, McpServerConfigEntry>>;
  readonly remove: readonly string[];
}

export type McpSourceServersChangeEvent = McpSourceServersChange & IWaitUntil;

export interface IProjectMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  sourceEntries(sourceId: McpProjectSourceId): Readonly<Record<string, McpServerConfigEntry>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;

  readonly onDidChangeSource: Event<McpSourceServersChangeEvent>;

  readonly onDidChangeTunables: Event<McpTunables>;
}

export const IProjectMcpConfigService: ServiceIdentifier<IProjectMcpConfigService> =
  createDecorator<IProjectMcpConfigService>('workspaceMcpConfigService');
