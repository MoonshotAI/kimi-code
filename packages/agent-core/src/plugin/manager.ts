import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { McpServerConfig } from '../config/schema';
import type { SkillRoot } from '../skill';
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
    // 临时阅读注释：启动时从 installed.json 恢复插件列表，并重新读取每个插件当前的 manifest。
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

    if (resolved.kind === 'local-path') {
      normalizedRoot = await normalizeInstallRoot(resolved.path);
      originalSource = resolved.path;
      sourceType = 'local-path';
      parsed = await parseManifest(normalizedRoot);
    } else {
      // zip-url
      const buffer = await downloadZip(resolved.path);
      const tmpDir = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-zip-'));
      let detectedRoot: string;
      try {
        detectedRoot = await extractZip(buffer, tmpDir);
      } catch (error) {
        await rm(tmpDir, { recursive: true, force: true });
        throw error;
      }
      parsed = await parseManifest(detectedRoot);
      if (parsed.manifest === undefined) {
        await rm(tmpDir, { recursive: true, force: true });
        const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error(`Cannot install plugin from ${resolved.path}: ${msg}`);
      }
      const id = normalizePluginId(parsed.manifest.name);
      const existing = this.records.get(id);
      if (existing !== undefined) {
        if (existing.source === 'local-path') {
          await rm(tmpDir, { recursive: true, force: true });
          throw new Error(`Plugin "${id}" is already installed from a local directory. Remove it first.`);
        }
      }
      normalizedRoot = path.join(this.kimiHomeDir, 'plugins', 'managed', id);
      const managedDir = path.dirname(normalizedRoot);
      await mkdir(managedDir, { recursive: true });
      const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
      try {
        await cp(detectedRoot, stagingRoot, { recursive: true });
        await rm(normalizedRoot, { recursive: true, force: true });
        await rename(stagingRoot, normalizedRoot);
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
      if (existing !== undefined) this.records.delete(id);
      normalizedRoot = await realpath(normalizedRoot);
      parsed = await parseManifest(normalizedRoot);
      await rm(tmpDir, { recursive: true, force: true });
      originalSource = resolved.path;
      sourceType = 'zip-url';
    }

    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${normalizedRoot}: ${msg}`);
    }
    const id = normalizePluginId(parsed.manifest.name);
    if (this.records.has(id)) {
      throw new Error(`Plugin "${id}" is already installed`);
    }
    const now = new Date().toISOString();
    const record = recordFrom({
      id,
      root: normalizedRoot,
      enabled: true,
      installedAt: now,
      updatedAt: now,
      originalSource,
      source: sourceType,
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    // 临时阅读注释：enable/disable 只改持久化状态；session 创建时才会重新读取这个状态。
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
    // 临时阅读注释：reload 用于用户手动改 manifest 或 installed.json 后刷新内存快照。
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
    // 临时阅读注释：这里把启用插件的 skills 目录转成 SkillRoot，并挂上 plugin instructions。
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: 'extra',
          plugin: {
            id: record.id,
            instructions: record.skillInstructions,
          },
        });
      }
    }
    return roots;
  }

  enabledSessionStarts(): readonly EnabledPluginSessionStart[] {
    // 临时阅读注释：sessionStart 是纯声明式 skill 注入，不执行插件脚本。
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
        if (!isMcpServerEnabled(record, name)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = config;
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
  // 临时阅读注释：安装路径必须是绝对路径并 realpath，避免 installed.json 里存相对路径造成 session 间语义不稳定。
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

function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  source?: PluginSource;
  parsed: ParsedManifestResult;
}): PluginRecord {
  // 临时阅读注释：manifest 里有 error diagnostic 时，插件仍可出现在列表里，但不会给 session 贡献 skills/sessionStart。
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  const base: PluginRecord = {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
  return base;
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.manifest?.skills?.length ?? 0,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
  };
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

function isMcpServerEnabled(record: PluginRecord, name: string): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled === true;
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
      enabled: isMcpServerEnabled(record, name),
      transport: 'http',
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name),
    transport: 'stdio',
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys: config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  return `plugin-${pluginId}-${serverName}`;
}
