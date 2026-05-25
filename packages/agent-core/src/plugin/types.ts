export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginBootstrap {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly capabilities?: readonly string[];
  readonly websiteURL?: string;
  readonly defaultPrompt?: readonly string[] | string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[]; // resolved absolute paths
  readonly bootstrap?: PluginBootstrap;
  readonly interface?: PluginInterface;
}

/** Fields recognized in `.codex-plugin/plugin.json` but not executed by Kimi. */
export interface PluginRecognizedFields {
  readonly hooks?: boolean;
  readonly mcpServers?: boolean;
  readonly apps?: boolean;
}

export type PluginManifestKind = 'native' | 'codex';
export type PluginSource = 'local-path';
export type PluginState = 'ok' | 'error';

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly hasErrors: boolean;
}

export interface PluginInfo extends PluginSummary {
  readonly source: PluginSource;
  readonly root: string;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledBootstrap {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}
