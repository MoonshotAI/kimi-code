import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { McpServerConfig } from '#/legacy/config-schema';
import type { HookDef } from './hooks';
import { parseManifest, type ParsedManifestResult } from './manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import {
  type EnabledPluginSessionStart,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type ReloadSummary,
  normalizePluginId,
} from './types';

/** A root directory to scan for skills. Local port of the retired
 *  agent-core skill scanner's root shape. */
export interface SkillRoot {
  readonly path: string;
  readonly source: 'project' | 'user' | 'extra' | 'builtin';
  readonly plugin?: { readonly id: string; readonly instructions?: string };
}

// Hidden Kimi CLI subcommand that re-enters as a Node interpreter.
// Used as fallback when an MCP server declares `"command": "node"` but the
// user is running a single-binary Kimi build that doesn't have `node` on PATH.
const KIMI_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
}

export class PluginManager {
  private readonly kimiHomeDir: string;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async install(source: string): Promise<PluginRecord> {
    // Install is a plugin *management* operation (download/extract/persist).
    // The SDK host exposes the read surface (load/enabledMcpServers/
    // enabledHooks) for the engine; the install pipeline (archive download,
    // github resolution, manifest write) is intentionally not ported - the
    // retired agent-core plugin manager owned it. Hosts should install
    // plugins through the CLI/daemon that still manages the plugin dir.
    void source;
    throw new Error(
      'Plugin install is not available under the Rust SDK host; manage plugins through the CLI/daemon.',
    );
  }


  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.enabled === enabled) return;
    const now = new Date().toISOString();
    this.records.set(key, { ...current, enabled, updatedAt: now });
    await this.persist();
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error(`Plugin "${id}" does not declare MCP server "${server}"`);
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    this.records.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    if (!this.records.delete(key)) {
      return;
    }
    await this.persist();
    // Clean up the managed plugin directory on disk.
    const managedRoot = join(this.kimiHomeDir, 'plugins', 'managed', key);
    await rm(managedRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        const record = await this.materialize(entry);
        next.set(entry.id, record);
        if (record.state === 'error') {
          const message =
            record.diagnostics?.find((d) => d.severity === 'error')?.message ??
            'failed to load plugin';
          errors.push({ id: entry.id, message });
        }
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  pluginSkillRoots(): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: 'extra',
          plugin: { id: record.id, instructions: record.skillInstructions },
        });
      }
    }
    return roots;
  }

  enabledSessionStarts(): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const skill = record.manifest?.sessionStart?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  enabledMcpServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          withMcpServerEnabled(config, true),
          record.root,
          this.kimiHomeDir,
        );
      }
    }
    return out;
  }

  enabledHooks(): readonly HookDef[] {
    const out: HookDef[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const hook of record.manifest.hooks ?? []) {
        out.push({
          ...hook,
          cwd: record.root,
          env: { KIMI_CODE_HOME: this.kimiHomeDir, KIMI_PLUGIN_ROOT: record.root },
        });
      }
    }
    return out;
  }

  async enabledCommands(): Promise<readonly PluginCommandDef[]> {
    // Command loading (skill/parser frontmatter) is not ported with the read
    // surface; hosts use the CLI/daemon for plugin command management.
    return [];
  }


  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(): Promise<void> {
    const installed: InstalledRecord[] = [...this.records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      originalSource: record.originalSource,
      capabilities: record.capabilities,
      github: record.github,
    }));
    await writeInstalled(this.kimiHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      source: entry.source,
      parsed,
    });
  }
}
async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  source?: PluginSource;
  parsed: ParsedManifestResult;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    skillCount: await countDiscoveredPluginSkills(input.id, parsed.manifest),
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.skillCount,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hookCount: record.manifest?.hooks?.length ?? 0,
    commandCount: record.manifest?.commands?.length ?? 0,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
  };
}

async function countDiscoveredPluginSkills(
  _pluginId: string,
  manifest: PluginRecord['manifest'],
): Promise<number> {
  // Lightweight skill count: each plugin skill root is a directory containing
  // SKILL.md entries. We count markdown skill files directly instead of
  // importing the retired agent-core skill scanner.
  const roots = manifest?.skills ?? [];
  if (roots.length === 0) return 0;
  let count = 0;
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md'))) count += 1;
        else if (entry.isFile() && entry.name.endsWith('.md')) count += 1;
      }
    } catch {
      // Unreadable root contributes nothing.
    }
  }
  return count;
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    mcpServers: pluginMcpServersInfo(record),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

function isMcpServerEnabled(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginRecord): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): PluginMcpServerInfo {
  if (config.transport === 'http' || config.transport === 'sse') {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: config.transport,
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: 'stdio',
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys: config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

function withMcpServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  return { ...config, enabled };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  // Plugin ids cannot contain ":", so this keeps plugin/server pairs unambiguous
  // even when either side contains "-".
  return `plugin-${pluginId}:${serverName}`;
}

function withPluginMcpRuntime(
  config: McpServerConfig,
  pluginRoot: string,
  kimiHomeDir: string,
): McpServerConfig {
  if (config.transport === 'http' || config.transport === 'sse') return config;

  const env = {
    ...config.env,
    KIMI_CODE_HOME: kimiHomeDir,
    KIMI_PLUGIN_ROOT: pluginRoot,
  };

  if (config.command === 'node' && isKimiNativeBinary()) {
    return {
      ...config,
      command: process.execPath,
      args: [KIMI_NODE_FALLBACK_SUBCOMMAND, ...(config.args ?? [])],
      cwd: config.cwd ?? pluginRoot,
      env,
    };
  }

  return { ...config, cwd: config.cwd ?? pluginRoot, env };
}

function isKimiNativeBinary(): boolean {
  return !basename(process.execPath).toLowerCase().startsWith('node');
}
