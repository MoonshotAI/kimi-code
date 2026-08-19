import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { McpServerConfig } from '#/mcpCore/config-schema';

export type McpServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryPluginOrigin {
  readonly id: string;
  /** Manifest-local server name (without the `plugin-<id>:` runtime prefix). */
  readonly name: string;
}

export interface McpRegistryEntry {
  /** Runtime name — for plugin entries the renamed `plugin-<id>:<name>` form. */
  readonly name: string;
  /** Final effective config after source-specific transforms. */
  readonly config: McpServerConfig;
  readonly source: McpServerSource;
  /** global: the defining file path; plugin: the plugin id; caller: `'caller'`. */
  readonly origin: string;
  /** True only for user-level global entries — the management API writes there. */
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
}

export interface McpRegistryQuery {
  /**
   * When set, the project-root and project-local layers join the global
   * source. Session-scoped resolutions pass the session workDir; the
   * process-global management plane usually omits it.
   */
  readonly cwd?: string;
}

export interface IMcpRegistryService {
  readonly _serviceBrand: undefined;

  list(query?: McpRegistryQuery): Promise<readonly McpRegistryEntry[]>;

  /** First match wins on a runtime-name collision (globals list first). */
  get(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry>;

  /**
   * Session-runtime resolution for one server name — the entry a live
   * session should actually run, as opposed to the management view which
   * lists every collision side by side. Returns `undefined` when no source
   * currently defines the name.
   */
  resolveRuntimeTarget(name: string, query?: McpRegistryQuery): Promise<McpRegistryEntry | undefined>;
}

export const IMcpRegistryService: ServiceIdentifier<IMcpRegistryService> =
  createDecorator<IMcpRegistryService>('mcpRegistryService');

export { mcpServerConfigsEqual } from '#/mcpCore/connection-manager';
