import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { McpServerConfig } from '../config/schema';
import { discoverSkills, type SkillRoot } from '../skill';
import { downloadZip, extractZip } from './archive';
import { parseManifest, type ParsedManifestResult } from './manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import { resolveInstallSource } from './source';
import {
  type EnabledPluginSessionStart,
  type PluginCapabilityState,
  type PluginInfo,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type ReloadSummary,
  normalizePluginId,
} from './types';

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
    const resolved = resolveInstallSource(source);

    let normalizedRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let parsed: ParsedManifestResult;
    let id: string;

    if (resolved.kind === 'local-path') {
      const sourceRoot = await normalizeInstallRoot(resolved.path);
      originalSource = resolved.path;
      sourceType = 'local-path';
      parsed = await parseManifest(sourceRoot);
      if (parsed.manifest === undefined) {
        const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error(`Cannot install plugin at ${sourceRoot}: ${msg}`);
      }
      id = normalizePluginId(parsed.manifest.name);
      normalizedRoot = await copyPluginToManagedRoot(this.kimiHomeDir, id, sourceRoot);
      parsed = await parseManifest(normalizedRoot);
    } else {
      // zip-url
      const buffer = await downloadZip(resolved.path);
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-zip-'));
      try {
        const detectedRoot = await extractZip(buffer, tmpDir);
        parsed = await parseManifest(detectedRoot);
        if (parsed.manifest === undefined) {
          const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
          throw new Error(`Cannot install plugin from ${resolved.path}: ${msg}`);
        }
        id = normalizePluginId(parsed.manifest.name);
        normalizedRoot = await copyPluginToManagedRoot(this.kimiHomeDir, id, detectedRoot);
        parsed = await parseManifest(normalizedRoot);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
      originalSource = resolved.path;
      sourceType = 'zip-url';
    }

    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${normalizedRoot}: ${msg}`);
    }
    id = normalizePluginId(parsed.manifest.name);
    const existing = this.records.get(id);
    const now = new Date().toISOString();
    const record = await recordFrom({
      id,
      root: normalizedRoot,
      enabled: existing?.enabled ?? true,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      originalSource,
      source: sourceType,
      capabilities: existing?.capabilities,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
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
      throw new Error(`Plugin "${id}" is not installed`);
    }
    await this.persist();
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
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
      source: entry.source,
      parsed,
    });
  }
}

async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Plugin root must be an absolute path (got "${rootPath}")`);
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error(`Plugin root does not exist: ${trimmed}`, { cause: error });
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${trimmed}`);
  }
  return resolved;
}

async function copyPluginToManagedRoot(
  kimiHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<string> {
  const managedRoot = path.join(kimiHomeDir, 'plugins', 'managed', id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    await rm(managedRoot, { recursive: true, force: true });
    await rename(stagingRoot, managedRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return realpath(managedRoot);
}

async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
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
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
  };
}

async function countDiscoveredPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
): Promise<number> {
  const roots = (manifest?.skills ?? []).map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
  }) satisfies SkillRoot);
  if (roots.length === 0) return 0;
  const skills = await discoverSkills({ roots });
  return skills.length;
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    source: record.source,
    root: record.root,
    originalSource: record.originalSource,
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
  if (config.transport === 'http') {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: 'http',
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
  if (config.transport === 'http') return config;

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
  return !path.basename(process.execPath).toLowerCase().startsWith('node');
}
