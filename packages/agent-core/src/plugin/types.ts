import type { McpServerConfig } from '../config/schema';
import type { SkillRoot } from '../skill';

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginSessionStart {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly websiteURL?: string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[]; // resolved absolute paths
  readonly sessionStart?: PluginSessionStart;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly interface?: PluginInterface;
  readonly skillInstructions?: string;
}

export interface PluginMcpServerState {
  readonly enabled: boolean;
}

export interface PluginCapabilityState {
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerState>>;
}

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export type PluginManifestKind = 'kimi-plugin-root' | 'kimi-plugin-dir';
export type PluginSource = 'local-path' | 'zip-url';
export type PluginState = 'ok' | 'error';

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly skillInstructions?: string;
  readonly skillCount: number;
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hasErrors: boolean;
}

export interface PluginInfo extends PluginSummary {
  readonly source: PluginSource;
  readonly root: string;
  readonly originalSource?: string;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledPluginSessionStart {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

/**
 * An immutable description of what the currently-enabled plugins want the
 * runtime to look like: skill roots to load, MCP servers to run, and
 * sessionStart skills to auto-inject. Produced by `PluginManager` and applied
 * to a live session by `Session.applyPluginRuntimeSnapshot`.
 */
export interface PluginRuntimeSnapshot {
  readonly pluginSkillRoots: readonly SkillRoot[];
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
}

/**
 * What `Session.applyPluginRuntimeSnapshot` was actually able to hot-load into
 * the current session. Only additive capabilities take effect live; anything
 * that would require tearing down existing state sets `needsNewSession`.
 */
export interface PluginRuntimeApplyResult {
  readonly addedSkills: readonly string[];
  readonly addedMcpServers: readonly string[];
  /**
   * True when the live session still differs from the snapshot in a way that
   * only a new session can reconcile: a disabled/removed plugin MCP server is
   * still connected, or the set of sessionStart injections drifted (new ones
   * cannot be injected mid-conversation, old ones cannot be retracted).
   */
  readonly needsNewSession: boolean;
}

/** Result of `/plugins reload`: the manager-level diff plus what was applied. */
export interface PluginReloadResult extends ReloadSummary {
  readonly applied?: PluginRuntimeApplyResult;
}

export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}
