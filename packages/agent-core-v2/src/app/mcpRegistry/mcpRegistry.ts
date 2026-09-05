import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { McpServerConfig } from '#/mcpCore/config-schema';

export type McpServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryPluginOrigin {
  readonly id: string;
  readonly name: string;
}

export interface McpRegistryEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly source: McpServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
}

export interface McpRegistryQuery {
  readonly cwd?: string;
}

export interface IMcpRegistryService {
  readonly _serviceBrand: undefined;

  list(query?: McpRegistryQuery): Promise<readonly McpRegistryEntry[]>;

  get(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry>;

  resolveRuntimeTarget(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry | undefined>;
}

export const IMcpRegistryService: ServiceIdentifier<IMcpRegistryService> =
  createDecorator<IMcpRegistryService>('mcpRegistryService');

export { mcpServerConfigsEqual } from '#/mcpCore/connection-manager';
