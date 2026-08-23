/**
 * Unified MCP server registry.
 *
 * v1 has three MCP server sources that used to be aggregated only at session
 * start (and only partially): the layered config files (`global`), plugin
 * manifests (`plugin`), and caller-injected session options (`caller`). The
 * registry presents all of them as one read view for the management plane:
 *
 *  - `global` entries come from the user-level `mcp.json` plus — when a `cwd`
 *    is supplied — the project-root `.mcp.json` and project-local
 *    `.kimi-code/mcp.json`. Only user-level entries are `mutable` through the
 *    management API (writes keep landing in the user-level file).
 *  - `plugin` entries come from `PluginManager.mcpServerEntries()`: the
 *    rename / env-injection / cwd-constraint transforms stay inside the plugin
 *    contributor, so the registry (and anything reading it) sees the final
 *    effective config. Plugin entries are read-only — config ownership lives
 *    in the plugin manifest.
 *  - `caller` entries exist only in session scope (SDK injection); the
 *    process-global management plane never has any.
 *
 * The registry is assembled per query: config files and the plugin install
 * state are the sources of truth, so nothing here needs invalidation.
 */

import type { McpServerConfig } from '#/config/schema';
import { ErrorCodes, KimiError } from '#/errors';
import type { PluginManager } from '#/plugin/manager';

import { loadMcpServersDetailed } from './config-loader';
import type { GlobalMcpConfigStore } from './global-config';

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

export interface McpServerRegistryOptions {
  readonly homeDir?: string;
  readonly store: GlobalMcpConfigStore;
  readonly plugins: PluginManager;
  /** Host-managed env merged into plugin stdio servers (see KimiCore). */
  readonly managedPluginEnv?: () => Record<string, string>;
}

export interface McpRegistryQuery {
  /**
   * When set, the project-root and project-local layers join the global
   * source. Session-scoped resolutions pass the session workDir; the
   * process-global management plane usually omits it.
   */
  readonly cwd?: string;
}

export class McpServerRegistry {
  private readonly options: McpServerRegistryOptions;

  constructor(options: McpServerRegistryOptions) {
    this.options = options;
  }

  async list(query: McpRegistryQuery = {}): Promise<readonly McpRegistryEntry[]> {
    const out: McpRegistryEntry[] = [];

    if (query.cwd === undefined) {
      const userEntries = await this.options.store.list();
      for (const server of userEntries) {
        const { name, ...config } = server;
        out.push({
          name,
          config,
          source: 'global',
          origin: this.options.store.path,
          mutable: true,
        });
      }
    } else {
      const detailed = await loadMcpServersDetailed({ cwd: query.cwd, homeDir: this.options.homeDir });
      for (const [name, config] of Object.entries(detailed.servers)) {
        const origin = detailed.origins[name] ?? this.options.store.path;
        out.push({
          name,
          config,
          source: 'global',
          origin,
          // Only entries whose effective definition lives in the user-level
          // file can be mutated through the management API — writing a
          // project-shadowed name would never change what sessions run.
          mutable: origin === this.options.store.path,
        });
      }
    }

    const managedEnv = this.options.managedPluginEnv?.();
    for (const entry of this.options.plugins.mcpServerEntries({ managedEnv })) {
      // A plugin entry whose runtime name collides with a global one is kept,
      // not dropped: the management plane must show the collision (the app
      // inspection surfaces it as `unavailable`) instead of hiding one side.
      out.push({
        name: entry.name,
        config: entry.config,
        source: 'plugin',
        origin: entry.pluginId,
        mutable: false,
        plugin: { id: entry.pluginId, name: entry.serverName },
      });
    }

    return out;
  }

  /** First match wins on a runtime-name collision (globals list first). */
  async get(name: string, query: McpRegistryQuery = {}): Promise<McpRegistryEntry> {
    const entry = (await this.list(query)).find((candidate) => candidate.name === name);
    if (entry !== undefined) return entry;
    throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" was not found`);
  }

  /**
   * Session-runtime resolution for one server name — the entry a live session
   * should actually run, as opposed to the management view which lists every
   * collision side by side:
   *
   *  - An enabled plugin entry wins over the file layers (project > user),
   *    matching the session-start merge order.
   *  - A disabled plugin descriptor is treated as absent, mirroring session
   *    start where disabled plugin servers never join a session at all.
   *  - Caller entries never appear here: SDK injection is session-scoped and
   *    shadows every registry source for its session.
   *
   * Returns `undefined` when no source currently defines the name.
   */
  async resolveRuntimeTarget(
    name: string,
    query: McpRegistryQuery = {},
  ): Promise<McpRegistryEntry | undefined> {
    const matches = (await this.list(query)).filter((entry) => entry.name === name);
    const plugin = matches.find(
      (entry) => entry.source === 'plugin' && entry.config.enabled !== false,
    );
    if (plugin !== undefined) return plugin;
    return matches.find((entry) => entry.source === 'global');
  }
}

/**
 * Structural equality for effective configs, used by live-session sync to
 * skip reconnects when a plugin reload produced byte-identical entries.
 */
export function mcpServerConfigsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return stableConfigJson(a) === stableConfigJson(b);
}

function stableConfigJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableConfigJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableConfigJson(entryValue)}`)
      .toSorted();
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
