/**
 * `workspaceMcpConfig` domain (L5) — Workspace-scoped MCP server-config owner
 * contract.
 *
 * Defines `IWorkspaceMcpConfigService`, the single source of truth for "which
 * MCP servers should this workspace run": it resolves the MCP config files
 * (user `mcp.json`, project-root `.mcp.json`, `.kimi-code/mcp.json`) and the
 * enabled plugins' contributions — on a name collision the file config wins —
 * with the two project-level files gated by `workspaceTrust` (an untrusted
 * workspace gets the user file and plugin contributions only), then tracks
 * both sources (fs watch on the config files,
 * `plugins.onDidReload`) and publishes the reconciled effective set as a
 * snapshot plus already-diffed change events. Consumers never read config
 * files, the plugin registry, or the `[mcp]` config section themselves: the
 * global timeout preferences are exposed here as {@link tunables} too, so the
 * connection side has exactly one configuration dependency. The domain holds
 * no connection state and never talks to an MCP server; writing config files
 * stays out of the engine (the node-sdk global store and the `/mcp-config`
 * skill are the external write paths). Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { McpServerConfig } from '#/mcpCore/config-schema';

/**
 * One reconciled change of the effective server set. `upsert` entries are new
 * or fingerprint-changed and ask the consumer to (re)connect; `remove` names
 * vanished from the effective set and ask it to disconnect. Entries whose
 * merged value did not actually change (e.g. a same-named fallback with an
 * identical config) produce no event.
 */
export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

/** The global `[mcp]` timeout preferences, as resolved by `config`. */
export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface IWorkspaceMcpConfigService {
  readonly _serviceBrand: undefined;

  /**
   * The initial resolve (config files + plugin contributions). Settles once
   * the first effective snapshot is available; a load failure is logged and
   * resolves to an empty snapshot rather than rejecting.
   */
  readonly ready: Promise<void>;

  /**
   * The current effective server set (file sources win name collisions).
   * Meaningful after {@link ready}; immutable — replaced wholesale on change.
   */
  servers(): Readonly<Record<string, McpServerConfig>>;

  /**
   * The global `[mcp]` timeout preferences, resolved live from `config` at
   * each call so a mid-session edit applies to the next (re)connect.
   */
  tunables(): McpTunables;

  /**
   * Fires when the effective set changes after the initial resolve (a
   * watched config file changed, or plugins reloaded). Never fires before
   * {@link ready} settles; empty diffs are suppressed.
   */
  readonly onDidChange: Event<McpServersChange>;
}

export const IWorkspaceMcpConfigService: ServiceIdentifier<IWorkspaceMcpConfigService> =
  createDecorator<IWorkspaceMcpConfigService>('workspaceMcpConfigService');
