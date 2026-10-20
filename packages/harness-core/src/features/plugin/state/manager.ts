import { basename, dirname, isAbsolute, join } from 'pathe';

import type { McpServerConfig } from '#/features/mcp/core/config-schema';
import { HostFsError, type OsFsPort } from '#/features/os/host/index';
import { discoverSkills, type SkillDiscoveryResult } from '#/features/skill/catalog/discovery';
import type { SkillRoot } from '#/features/skill/catalog/types';

import { downloadZip, extractZip } from '../acquire/archive';
import { resolveGithubCommitSha, resolveGithubSource } from '../acquire/github';
import { resolveInstallSource } from '../acquire/source';
import { PluginError } from '../errors';
import type { HookDef } from '../hooks';
import { loadPluginCommand } from '../inspect/commands';
import { parseManifest, type ParsedManifestResult } from '../manifest/manifest';
import {
  normalizePluginId,
  type EnabledPluginSessionStart,
  type EnabledPluginSystemPrompt,
  type PluginAgentRoot,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerEntry,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type PluginUpdateStatus,
  type ReloadSummary,
} from '../types';

import { readInstalled, writeInstalled, type InstalledRecord } from './store';

export interface PluginManagerOptions {
  readonly homeDir: string;
  readonly fs: OsFsPort;
  readonly discoverSkills?: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
}

interface ManagedPluginCopy {
  readonly root: string;
  readonly previousRoot?: string;
}

export class PluginManager {
  private readonly homeDir: string;
  private readonly fs: OsFsPort;
  private readonly discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.homeDir = options.homeDir;
    this.fs = options.fs;
    this.discoverSkills =
      options.discoverSkills ?? ((roots) => discoverSkills(options.fs, roots));
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.fs, this.homeDir);
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

    let sourceRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let zipTmpDir: string | undefined;
    let managedCopy: ManagedPluginCopy | undefined;
    let github: PluginGithubMetadata | undefined;

    try {
      if (resolved.kind === 'local-path') {
        sourceRoot = await this.normalizeInstallRoot(resolved.path);
        originalSource = resolved.path;
        sourceType = 'local-path';
      } else {
        originalSource = source.trim();
        sourceType = resolved.kind === 'github' ? 'github' : 'zip-url';
        const zipUrl =
          resolved.kind === 'github'
            ? await (async () => {
                const resolution = await resolveGithubSource(resolved);
                const installedSha = await installedGithubSha(
                  resolved.owner,
                  resolved.repo,
                  resolution.ref,
                );
                github = {
                  owner: resolved.owner,
                  repo: resolved.repo,
                  ref: resolution.ref,
                  installedSha,
                };
                if (installedSha !== undefined) {
                  return `https://codeload.github.com/${resolved.owner}/${resolved.repo}/zip/${installedSha}`;
                }
                return resolution.tarballUrl;
              })()
            : resolved.path;
        const buffer = await downloadZip(zipUrl);
        zipTmpDir = join(this.homeDir, 'plugins', `.zip-staging-${crypto.randomUUID()}`);
        sourceRoot = await extractZip(this.fs, buffer, zipTmpDir);
      }

      const parsed = await parseManifest(this.fs, sourceRoot);
      if (parsed.manifest === undefined) {
        const msg =
          parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new PluginError(
          'plugin.load_failed',
          sourceType === 'local-path'
            ? `Cannot install plugin at ${sourceRoot}: ${msg}`
            : `Cannot install plugin from ${originalSource}: ${msg}`,
          { details: { sourceType } },
        );
      }

      const id = normalizePluginId(parsed.manifest.name);
      managedCopy = await this.copyPluginToManagedRoot(id, sourceRoot);
      const normalizedRoot = managedCopy.root;
      const managedParsed = await parseManifest(this.fs, normalizedRoot);
      const existing = this.records.get(id);
      const now = new Date().toISOString();
      const record = await this.recordFrom({
        id,
        root: normalizedRoot,
        enabled: existing?.enabled ?? true,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        originalSource,
        source: sourceType,
        capabilities: existing?.capabilities,
        github,
        parsed: managedParsed,
      });
      const next = new Map([...this.records, [id, record]]);
      await this.persist(next);
      this.records = next;
      if (managedCopy.previousRoot !== undefined) {
        await this.fs.remove(managedCopy.previousRoot).catch(() => undefined);
      }
      managedCopy = undefined;
      return record;
    } catch (error) {
      if (managedCopy !== undefined) {
        try {
          await this.rollbackManagedPluginCopy(managedCopy);
        } catch (rollbackError) {
          throw new PluginError(
            'plugin.load_failed',
            'Plugin installation failed and the previous managed copy could not be restored',
            {
              cause: new AggregateError(
                [error, rollbackError],
                'Plugin installation failed and the previous managed copy could not be restored',
                { cause: error },
              ),
            },
          );
        }
      }
      throw error;
    } finally {
      if (zipTmpDir !== undefined) {
        await this.fs.remove(zipTmpDir).catch(() => undefined);
      }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.enabled === enabled) return;
    const next = new Map([
      ...this.records,
      [key, { ...current, enabled, updatedAt: new Date().toISOString() }],
    ]);
    await this.persist(next);
    this.records = next;
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new PluginError(
        'mcp.server_not_found',
        `Plugin "${id}" does not declare MCP server "${server}"`,
        { details: { id, server } },
      );
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    const next = new Map([
      ...this.records,
      [
        key,
        {
          ...current,
          capabilities: nextCapabilities,
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);
    await this.persist(next);
    this.records = next;
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    const next = new Map(this.records);
    if (!next.delete(key)) {
      throw pluginNotFound(id);
    }
    await this.persist(next);
    this.records = next;
  }

  async checkUpdates(): Promise<readonly PluginUpdateStatus[]> {
    const records = [...this.records.values()].filter(
      (record) => record.source === 'github' && record.github !== undefined,
    );
    const results = await Promise.all(
      records.map(async (record) => {
        try {
          return await checkGithubUpdate(record);
        } catch {
          return undefined;
        }
      }),
    );
    return results
      .filter((result): result is PluginUpdateStatus => result !== undefined)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.fs, this.homeDir);
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

  enabledHooks(): readonly HookDef[] {
    const out: HookDef[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const hook of record.manifest.hooks ?? []) {
        out.push({
          ...hook,
          cwd: record.root,
          env: {
            KIMI_CODE_HOME: this.homeDir,
            KIMI_PLUGIN_ROOT: record.root,
          },
        });
      }
    }
    return out;
  }

  async enabledCommands(): Promise<readonly PluginCommandDef[]> {
    const out: PluginCommandDef[] = [];
    const records = [...this.records.values()];
    for (const record of records) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const entry of record.manifest.commands ?? []) {
        const def = await loadPluginCommand(this.fs, {
          commandPath: entry.path,
          pluginId: record.id,
          fallbackName: entry.name,
        });
        if (def !== undefined) out.push(def);
      }
    }
    return out;
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
          scanMode: record.manifest.rootSkillFallback ? 'root-skill-only' : undefined,
        });
      }
    }
    return roots;
  }

  pluginAgentRoots(): readonly PluginAgentRoot[] {
    const roots: PluginAgentRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.agents ?? []) {
        roots.push({ path: dir, source: 'plugin' });
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

  enabledSystemPrompts(): readonly EnabledPluginSystemPrompt[] {
    const out: EnabledPluginSystemPrompt[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const content = record.manifest?.systemPrompt;
      if (content === undefined) continue;
      out.push({ pluginId: record.id, content });
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
          this.homeDir,
        );
      }
    }
    return out;
  }

  mcpServerEntries(): readonly PluginMcpServerEntry[] {
    const out: PluginMcpServerEntry[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        const enabled = record.enabled && isMcpServerEnabled(record, name, config);
        const effective = withPluginMcpRuntime(
          withMcpServerEnabled(config, enabled),
          record.root,
          this.homeDir,
        );
        out.push({
          name: pluginMcpRuntimeName(record.id, name),
          config: effective,
          pluginId: record.id,
          serverName: name,
        });
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

  private async persist(records: ReadonlyMap<string, PluginRecord>): Promise<void> {
    const installed: InstalledRecord[] = [...records.values()].map((record) => ({
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
    await writeInstalled(this.fs, this.homeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(this.fs, entry.root);
    return this.recordFrom({
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

  private async normalizeInstallRoot(rootPath: string): Promise<string> {
    const trimmed = rootPath.trim();
    if (!isAbsolute(trimmed)) {
      throw new PluginError(
        'validation.failed',
        `Plugin root must be an absolute path (got "${rootPath}")`,
        { details: { path: rootPath } },
      );
    }
    let resolved: string;
    try {
      resolved = await this.fs.realpath(trimmed);
    } catch (error) {
      throw new PluginError('fs.path_not_found', `Plugin root does not exist: ${trimmed}`, {
        cause: error,
        details: { path: trimmed },
      });
    }
    if (!(await this.fs.stat(resolved)).isDirectory) {
      throw new PluginError('validation.failed', `Plugin root is not a directory: ${trimmed}`, {
        details: { path: trimmed },
      });
    }
    return resolved;
  }

  private async copyPluginToManagedRoot(
    id: string,
    sourceRoot: string,
  ): Promise<ManagedPluginCopy> {
    const managedRoot = join(this.homeDir, 'plugins', 'managed', id);
    const managedDir = dirname(managedRoot);
    await this.fs.mkdir(managedDir, { recursive: true });
    const stagingRoot = join(managedDir, `${id}-${crypto.randomUUID()}`);
    const previousRoot = `${stagingRoot}-previous`;
    let movedPreviousRoot = false;
    let published = false;
    try {
      await copyDirectory(this.fs, sourceRoot, stagingRoot);
      try {
        await this.fs.rename(managedRoot, previousRoot);
        movedPreviousRoot = true;
      } catch (error) {
        if (!(error instanceof HostFsError && error.code === 'os.fs.not_found')) throw error;
      }
      await this.fs.rename(stagingRoot, managedRoot);
      published = true;
      return {
        root: await this.fs.realpath(managedRoot),
        previousRoot: movedPreviousRoot ? previousRoot : undefined,
      };
    } catch (error) {
      await this.fs.remove(published ? managedRoot : stagingRoot).catch(() => undefined);
      if (movedPreviousRoot) await this.fs.rename(previousRoot, managedRoot);
      throw error;
    }
  }

  private async rollbackManagedPluginCopy(copy: ManagedPluginCopy): Promise<void> {
    await this.fs.remove(copy.root);
    if (copy.previousRoot !== undefined) {
      await this.fs.rename(copy.previousRoot, copy.root);
    }
  }

  private async recordFrom(input: {
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
      skillCount: await countDiscoveredPluginSkills(input.id, parsed.manifest, this.discoverSkills),
      manifest: parsed.manifest,
      manifestKind: parsed.manifestKind,
      manifestPath: parsed.manifestPath,
      shadowedManifestPath: parsed.shadowedManifestPath,
      diagnostics: parsed.diagnostics,
      skillInstructions: parsed.manifest?.skillInstructions,
    };
  }
}

async function copyDirectory(fs: OsFsPort, from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isSymbolicLink === true) {
      if ((await fs.stat(src)).isDirectory) {
        await copyDirectory(fs, src, dst);
      } else {
        await fs.writeBytes(dst, await fs.readBytes(src));
      }
      continue;
    }
    if (entry.isDirectory) {
      await copyDirectory(fs, src, dst);
      continue;
    }
    if (entry.isFile) {
      await fs.writeBytes(dst, await fs.readBytes(src));
    }
  }
}

async function installedGithubSha(
  owner: string,
  repo: string,
  ref: PluginGithubMetadata['ref'],
): Promise<string | undefined> {
  if (ref.kind === 'sha' && ref.value.length === 40) return ref.value.toLowerCase();
  return resolveGithubCommitSha(owner, repo, ref.value);
}

async function checkGithubUpdate(record: PluginRecord): Promise<PluginUpdateStatus> {
  const github = record.github;
  if (github === undefined)
    throw new PluginError('plugin.load_failed', `Plugin "${record.id}" has no GitHub metadata`, {
      details: { id: record.id },
    });
  const current = github.ref;
  const pinned = explicitGithubRef(record);

  if (pinned?.kind === 'tag' || pinned?.kind === 'sha') {
    return {
      id: record.id,
      source: 'github',
      current,
      latest: current,
      displayVersion: current.value,
      updateAvailable: false,
    };
  }

  if (pinned?.kind === 'branch') {
    const latestSha = await resolveGithubCommitSha(github.owner, github.repo, pinned.value);
    return {
      id: record.id,
      source: 'github',
      current,
      latest: current,
      displayVersion: latestSha.slice(0, 12),
      updateAvailable: github.installedSha === undefined || github.installedSha !== latestSha,
    };
  }

  const latest = await resolveGithubSource({
    kind: 'github',
    owner: github.owner,
    repo: github.repo,
  });
  let updateAvailable = current.kind !== latest.ref.kind || current.value !== latest.ref.value;
  if (!updateAvailable && (latest.ref.kind === 'branch' || latest.ref.kind === 'tag')) {
    const latestSha = await resolveGithubCommitSha(github.owner, github.repo, latest.ref.value);
    updateAvailable = github.installedSha === undefined || github.installedSha !== latestSha;
  }
  return {
    id: record.id,
    source: 'github',
    current,
    latest: latest.ref,
    displayVersion: latest.displayVersion,
    updateAvailable,
  };
}

function explicitGithubRef(record: PluginRecord): PluginGithubMetadata['ref'] | undefined {
  const fallback =
    record.github?.ref.kind === 'sha' ||
    (record.github?.ref.kind === 'branch' && record.github.ref.value !== 'HEAD')
      ? record.github.ref
      : undefined;
  if (record.originalSource === undefined) return fallback;
  try {
    const source = resolveInstallSource(record.originalSource);
    return source.kind === 'github' ? source.ref : fallback;
  } catch {
    return fallback;
  }
}

function pluginNotFound(id: string): PluginError {
  return new PluginError('plugin.not_found', `Plugin "${id}" is not installed`, {
    details: { id },
  });
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

function isMcpServerEnabled(record: PluginRecord, name: string, config: McpServerConfig): boolean {
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

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  return `plugin-${pluginId}:${serverName}`;
}

const KIMI_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

function withMcpServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  return { ...config, enabled };
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

  if (config.command === 'node' && isElectron()) {
    return {
      ...config,
      command: process.execPath,
      args: config.args ?? [],
      cwd: config.cwd ?? pluginRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }

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

function isElectron(): boolean {
  return typeof process.versions['electron'] === 'string';
}

function isKimiNativeBinary(): boolean {
  return !basename(process.execPath).toLowerCase().startsWith('node');
}

async function countDiscoveredPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
  discover: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>,
): Promise<number> {
  const dirs = manifest?.skills ?? [];
  if (dirs.length === 0) return 0;
  const roots: SkillRoot[] = dirs.map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
    scanMode: manifest?.rootSkillFallback ? 'root-skill-only' : undefined,
  }));
  const result = await discover(roots);
  return result.skills.length;
}
