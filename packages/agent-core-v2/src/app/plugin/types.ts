import type { IWaitUntil } from '#/_base/event';
import type { HookDefConfig } from '#/features/externalHooks/configSection';
import type { McpServerConfig } from '#/mcpCore/config-schema';

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

export interface PluginAgentRoot {
  readonly path: string;
  readonly source: 'plugin';
}

export interface PluginInterfaceOverride {
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly websiteURL?: string;
  readonly defaultLocale?: string;
  readonly locales?: string;
  readonly mcpOverrides?: Readonly<Record<string, PluginInterfaceOverride>>;
  readonly skillOverrides?: Readonly<Record<string, PluginInterfaceOverride>>;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[];
  readonly rootSkillFallback?: boolean;
  readonly agents?: readonly string[];
  readonly sessionStart?: PluginSessionStart;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly hooks?: readonly HookDefConfig[];
  readonly commands?: readonly PluginCommandEntry[];
  readonly interface?: PluginInterface;
  readonly skillInstructions?: string;
  readonly systemPrompt?: string;
}

export interface PluginMcpServerState {
  readonly enabled: boolean;
}

export interface PluginCapabilityState {
  readonly mcpServers?: Readonly<Record<string, PluginMcpServerState>>;
}

export interface PluginSkillInfo {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}

export interface PluginSkillRecord extends PluginSkillInfo {
  readonly overrideKey: string;
}

export interface PluginCapabilities {
  readonly skills: readonly PluginSkillInfo[];
  readonly mcpServers: readonly PluginMcpServerInfo[];
}

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface PluginMcpServerEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly pluginId: string;
  readonly serverName: string;
}

export interface PluginCommandDef {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path: string;
}

export interface PluginCommandEntry {
  readonly path: string;
  readonly name: string;
}

export type PluginManifestKind = 'kimi-plugin-root' | 'kimi-plugin-dir';
export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginOrigin = 'marketplace' | 'custom' | 'unknown';
export type PluginState = 'ok' | 'error';

export interface PluginGithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadata {
  readonly owner: string;
  readonly repo: string;
  readonly ref: PluginGithubRef;
  readonly installedSha?: string;
}

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly origin: PluginOrigin;
  readonly catalogId?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly originalSource?: string;
  readonly capabilities?: PluginCapabilityState;
  readonly github?: PluginGithubMetadata;
  readonly skillInstructions?: string;
  readonly skills?: readonly PluginSkillRecord[];
  readonly skillCount: number;
  readonly manifest?: PluginManifest;
  readonly interfaceLocales?: Readonly<Record<string, PluginInterface>>;
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
  readonly hookCount: number;
  readonly commandCount: number;
  readonly hasErrors: boolean;
  readonly source: PluginSource;
  readonly origin: PluginOrigin;
  readonly catalogId?: string;
  readonly installedAt: string;
  readonly originalSource?: string;
  readonly github?: PluginGithubMetadata;
}

export interface PluginInfo extends PluginSummary, PluginCapabilities {
  readonly root: string;
  readonly updatedAt?: string;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledPluginSessionStart {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface EnabledPluginSystemPrompt {
  readonly pluginId: string;
  readonly content: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export type PluginReloadEvent = ReloadSummary & IWaitUntil;

export interface PluginMutation {
  readonly kind: 'install' | 'enable' | 'disable' | 'remove' | 'mcp-server';
  readonly id: string;
}

export interface PluginMutationSummary extends ReloadSummary {
  readonly mutation: PluginMutation;
}

export interface PluginUpdateStatus {
  readonly id: string;
  readonly source: PluginSource;
  readonly current?: PluginGithubRef;
  readonly latest: PluginGithubRef;
  readonly displayVersion: string;
  readonly updateAvailable: boolean;
}

export const PLUGIN_NAME_REGEX = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:@[A-Za-z0-9_-]+)?$/;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}
