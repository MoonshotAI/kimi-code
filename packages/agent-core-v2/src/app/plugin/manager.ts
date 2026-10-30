import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { HookDef } from '#/features/externalHooks/internal/types';
import { discoverFileSkills } from '#/features/skill/catalog/fileSkillDiscovery';
import type { SkillDiscoveryResult } from '#/features/skill/catalog/skillDiscovery';
import type { SkillRoot } from '#/features/skill/catalog/types';
import { BugIndicatingError, Error2, ErrorCodes, PluginErrors } from '#/errors';
import type { McpServerConfig } from '#/mcpCore/config-schema';

import { downloadZip, extractZip } from './archive';
import { loadPluginCommand } from './commands';
import { resolveGithubCommitSha, resolveGithubSource } from './github-resolver';
import { parseManifest, type ParsedManifestResult } from './manifest';
import { PluginPackageCache } from './packageCache';
import { resolveInstallSource } from './source';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import type { PluginAgentRoot } from './types';
import {
  normalizePluginId,
  type EnabledPluginSessionStart,
  type EnabledPluginSystemPrompt,
  type PluginCapabilities,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginInterface,
  type PluginMcpServerEntry,
  type PluginMcpServerInfo,
  type PluginOrigin,
  type PluginSkillInfo,
  type PluginRecord,
  type PluginSource,
  type PluginSummary,
  type PluginUpdateStatus,
  type ReloadSummary,
} from './types';

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
  readonly discoverSkills?: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
}

export interface PluginInstallOptions {
  readonly expectedSha256?: string;
  readonly expectedPluginId?: string;
  readonly origin?: PluginOrigin;
  readonly catalogId?: string;
  readonly migrateFrom?: string;
  readonly requiredSkill?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface PluginInspectionOptions {
  readonly expectedSha256: string;
  readonly expectedPluginId: string;
  readonly locale?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ManagedPluginCopy {
  readonly root: string;
  readonly previousRoot?: string;
}

interface RequiredPluginSkill {
  readonly pluginId: string;
  readonly name: string;
}

export interface PluginInstallReloadResult {
  readonly record: PluginRecord;
  readonly summary: ReloadSummary;
}

type PluginInspection = Pick<
  PluginRecord,
  'id' | 'capabilities' | 'manifest' | 'interfaceLocales' | 'skills'
>;

const INSPECTION_CACHE_LIMIT = 20;

export class PluginManager {
  private readonly kimiHomeDir: string;
  private readonly discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
  private readonly packages: PluginPackageCache;
  private readonly inspections = new Map<string, PluginInspection>();
  private readonly inspectionLoads = new Map<string, Promise<PluginInspection>>();
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
    this.discoverSkills = options.discoverSkills ?? discoverFileSkills;
    this.packages = new PluginPackageCache(options.kimiHomeDir);
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

  async install(source: string, options: PluginInstallOptions = {}): Promise<PluginRecord> {
    return this.installInternal(source, options, false);
  }

  async installAndReload(
    source: string,
    options: PluginInstallOptions = {},
  ): Promise<PluginInstallReloadResult> {
    return this.installInternal(source, options, true);
  }

  private async installInternal(
    source: string,
    options: PluginInstallOptions,
    reloadAfterInstall: false,
  ): Promise<PluginRecord>;
  private async installInternal(
    source: string,
    options: PluginInstallOptions,
    reloadAfterInstall: true,
  ): Promise<PluginInstallReloadResult>;
  private async installInternal(
    source: string,
    options: PluginInstallOptions,
    reloadAfterInstall: boolean,
  ): Promise<PluginRecord | PluginInstallReloadResult> {
    const resolved = resolveInstallSource(source);
    const migrateFrom =
      options.migrateFrom === undefined ? undefined : normalizePluginId(options.migrateFrom);
    const legacy = migrateFrom === undefined ? undefined : this.records.get(migrateFrom);
    if (options.expectedSha256 !== undefined && resolved.kind !== 'zip-url') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Marketplace plugin installation requires an HTTP(S) ZIP source',
        { details: { source } },
      );
    }

    let sourceRoot: string;
    let originalSource: string;
    let sourceType: PluginSource;
    let zipTmpDir: string | undefined;
    let managedCopy: ManagedPluginCopy | undefined;
    let github: PluginGithubMetadata | undefined;
    const previousRecords = this.records;
    let persisted = false;

    try {
      if (resolved.kind === 'local-path') {
        sourceRoot = await normalizeInstallRoot(resolved.path);
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
        const buffer =
          options.expectedSha256 === undefined
            ? await downloadZip(zipUrl, undefined, options.fetchImpl)
            : await this.packages.load(zipUrl, {
                expectedSha256: options.expectedSha256,
                expectedPluginId: options.expectedPluginId,
                fetchImpl: options.fetchImpl,
              });
        zipTmpDir = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-zip-'));
        sourceRoot = await extractZip(buffer, zipTmpDir);
      }

      const parsed = await parseManifest(sourceRoot);
      if (parsed.manifest === undefined) {
        const msg =
          parsed.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no manifest';
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          sourceType === 'local-path'
            ? `Cannot install plugin at ${sourceRoot}: ${msg}`
            : `Cannot install plugin from ${originalSource}: ${msg}`,
          { details: { sourceType } },
        );
      }
      if (
        options.expectedPluginId !== undefined &&
        parsed.manifest.name !== options.expectedPluginId
      ) {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Plugin manifest ID mismatch: expected "${options.expectedPluginId}", got "${parsed.manifest.name}"`,
          {
            details: {
              expectedPluginId: options.expectedPluginId,
              actualPluginId: parsed.manifest.name,
            },
          },
        );
      }

      const id = normalizePluginId(parsed.manifest.name);
      if (migrateFrom === id) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Plugin migration source and target must differ (both are "${id}")`,
          { details: { migrateFrom, pluginId: id } },
        );
      }
      managedCopy = await copyPluginToManagedRoot(this.kimiHomeDir, id, sourceRoot);
      const normalizedRoot = managedCopy.root;
      const managedParsed = await parseManifest(normalizedRoot);
      const existing = this.records.get(id);
      const now = new Date().toISOString();
      const record = await recordFrom({
        id,
        root: normalizedRoot,
        enabled: existing?.enabled ?? legacy?.enabled ?? true,
        installedAt: existing?.installedAt ?? legacy?.installedAt ?? now,
        updatedAt: now,
        originalSource,
        source: sourceType,
        origin: options.origin ?? legacy?.origin ?? 'custom',
        catalogId: options.catalogId,
        capabilities: existing?.capabilities ?? legacy?.capabilities,
        github,
        parsed: managedParsed,
        requiredSkill: options.requiredSkill,
        discoverSkills: this.discoverSkills,
      });
      const next = new Map(this.records);
      if (migrateFrom !== undefined) next.delete(migrateFrom);
      next.set(id, record);
      await this.persist(next);
      this.records = next;
      persisted = true;
      let result: PluginRecord | PluginInstallReloadResult = record;
      if (reloadAfterInstall) {
        const requiredSkill =
          options.requiredSkill === undefined
            ? undefined
            : { pluginId: id, name: options.requiredSkill };
        const summary = await this.reload(requiredSkill);
        if (options.requiredSkill !== undefined && summary.errors.length > 0) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            `Plugin "${id}" failed to reload after installation: ${summary.errors.map((entry) => `${entry.id}: ${entry.message}`).join('; ')}`,
            { details: { pluginId: id, errors: summary.errors } },
          );
        }
        const installedRecord = this.records.get(id);
        if (installedRecord === undefined) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            `Plugin "${id}" is missing after installation reload`,
            { details: { pluginId: id, errors: summary.errors } },
          );
        }
        if (
          options.requiredSkill !== undefined &&
          (installedRecord.state !== 'ok' || installedRecord.manifest === undefined)
        ) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            `Plugin "${id}" is not healthy after installation reload`,
            { details: { pluginId: id, diagnostics: installedRecord.diagnostics } },
          );
        }
        result = { record: installedRecord, summary };
      }
      if (managedCopy.previousRoot !== undefined) {
        await rm(managedCopy.previousRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      managedCopy = undefined;
      return result;
    } catch (error) {
      const restorationErrors: unknown[] = [];
      if (persisted) {
        try {
          await this.persist(previousRecords);
        } catch (restoreError) {
          restorationErrors.push(restoreError);
        }
        this.records = previousRecords;
      }
      if (managedCopy !== undefined) {
        try {
          await rollbackManagedPluginCopy(managedCopy);
        } catch (rollbackError) {
          restorationErrors.push(rollbackError);
        }
      }
      if (restorationErrors.length > 0) {
        const message =
          'Plugin installation failed and the previous plugin state could not be fully restored';
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, message, {
          cause: new AggregateError([error, ...restorationErrors], message, { cause: error }),
        });
      }
      throw error;
    } finally {
      if (zipTmpDir !== undefined) {
        await rm(zipTmpDir, { recursive: true, force: true });
      }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.enabled === enabled) return;
    const next = new Map(this.records);
    next.set(key, { ...current, enabled, updatedAt: new Date().toISOString() });
    await this.persist(next);
    this.records = next;
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error2(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
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
    const next = new Map(this.records);
    next.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
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

  async reload(requiredSkill?: RequiredPluginSkill): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(
          entry.id,
          await this.materialize(
            entry,
            entry.id === requiredSkill?.pluginId ? requiredSkill.name : undefined,
          ),
        );
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
            KIMI_CODE_HOME: this.kimiHomeDir,
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
        const def = await loadPluginCommand({
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
          this.kimiHomeDir,
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
          this.kimiHomeDir,
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

  info(id: string, locale?: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record, locale);
  }

  async inspect(
    source: string,
    options: PluginInspectionOptions,
  ): Promise<PluginCapabilities> {
    const resolved = resolveInstallSource(source);
    if (resolved.kind !== 'zip-url') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Marketplace plugin inspection requires an HTTP(S) ZIP source',
        { details: { source } },
      );
    }
    const cacheKey = options.expectedSha256.toLowerCase();
    const cached = this.inspections.get(cacheKey);
    if (cached !== undefined) {
      this.inspections.delete(cacheKey);
      this.inspections.set(cacheKey, cached);
      return pluginCapabilities(cached, options.locale);
    }
    const pending = this.inspectionLoads.get(cacheKey);
    if (pending !== undefined) return pluginCapabilities(await pending, options.locale);
    const load = this.inspectArchive(resolved.path, options);
    this.inspectionLoads.set(cacheKey, load);
    try {
      const record = await load;
      this.inspections.set(cacheKey, record);
      if (this.inspections.size > INSPECTION_CACHE_LIMIT) {
        const oldest = this.inspections.keys().next().value;
        if (oldest !== undefined) this.inspections.delete(oldest);
      }
      return pluginCapabilities(record, options.locale);
    } finally {
      if (this.inspectionLoads.get(cacheKey) === load) this.inspectionLoads.delete(cacheKey);
    }
  }

  private async inspectArchive(
    source: string,
    options: PluginInspectionOptions,
  ): Promise<PluginInspection> {
    const buffer = await this.packages.load(source, {
      expectedSha256: options.expectedSha256,
      expectedPluginId: options.expectedPluginId,
      fetchImpl: options.fetchImpl,
    });
    const zipTmpDir = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-inspect-'));
    try {
      const sourceRoot = await extractZip(buffer, zipTmpDir);
      const parsed = await parseManifest(sourceRoot);
      if (parsed.manifest === undefined) {
        const message =
          parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
          'no manifest';
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Cannot inspect plugin from ${source}: ${message}`,
          { details: { source } },
        );
      }
      if (parsed.manifest.name !== options.expectedPluginId) {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Plugin manifest ID mismatch: expected "${options.expectedPluginId}", got "${parsed.manifest.name}"`,
          {
            details: {
              expectedPluginId: options.expectedPluginId,
              actualPluginId: parsed.manifest.name,
            },
          },
        );
      }
      const record = await recordFrom({
        id: normalizePluginId(parsed.manifest.name),
        root: sourceRoot,
        enabled: true,
        installedAt: new Date(0).toISOString(),
        source: 'zip-url',
        origin: 'marketplace',
        parsed,
        discoverSkills: this.discoverSkills,
      });
      if (record.state === 'error') {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Plugin "${record.id}" has an invalid manifest`,
          { details: { pluginId: record.id, diagnostics: record.diagnostics } },
        );
      }
      return {
        id: record.id,
        capabilities: record.capabilities,
        manifest: record.manifest,
        interfaceLocales: record.interfaceLocales,
        skills: record.skills,
      };
    } finally {
      await rm(zipTmpDir, { recursive: true, force: true });
    }
  }

  private async persist(records: ReadonlyMap<string, PluginRecord>): Promise<void> {
    const installed: InstalledRecord[] = [...records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      origin: record.origin,
      catalogId: record.catalogId,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      originalSource: record.originalSource,
      capabilities: record.capabilities,
      github: record.github,
    }));
    await writeInstalled(this.kimiHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(
    entry: InstalledRecord,
    requiredSkill?: string,
  ): Promise<PluginRecord> {
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
      origin: entry.origin === 'marketplace' || entry.origin === 'custom' ? entry.origin : 'unknown',
      catalogId: entry.catalogId,
      parsed,
      requiredSkill,
      discoverSkills: this.discoverSkills,
    });
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
    throw new BugIndicatingError(`Plugin "${record.id}" has no GitHub metadata`);
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

function pluginNotFound(id: string): Error2 {
  return new Error2(PluginErrors.codes.PLUGIN_NOT_FOUND, `Plugin "${id}" is not installed`, {
    details: { id },
  });
}

async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Plugin root must be an absolute path (got "${rootPath}")`,
      { details: { path: rootPath } },
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `Plugin root does not exist: ${trimmed}`, {
      cause: error,
      details: { path: trimmed },
    });
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Plugin root is not a directory: ${trimmed}`, {
      details: { path: trimmed },
    });
  }
  return resolved;
}

async function copyPluginToManagedRoot(
  kimiHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<ManagedPluginCopy> {
  const managedRoot = path.join(kimiHomeDir, 'plugins', 'managed', id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  const previousRoot = `${stagingRoot}-previous`;
  let movedPreviousRoot = false;
  let published = false;
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    try {
      await rename(managedRoot, previousRoot);
      movedPreviousRoot = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(stagingRoot, managedRoot);
    published = true;
    return {
      root: await realpath(managedRoot),
      previousRoot: movedPreviousRoot ? previousRoot : undefined,
    };
  } catch (error) {
    await rm(published ? managedRoot : stagingRoot, { recursive: true, force: true });
    if (movedPreviousRoot) await rename(previousRoot, managedRoot);
    throw error;
  }
}

async function rollbackManagedPluginCopy(copy: ManagedPluginCopy): Promise<void> {
  await rm(copy.root, { recursive: true, force: true });
  if (copy.previousRoot !== undefined) {
    await rename(copy.previousRoot, copy.root);
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
  origin: PluginOrigin;
  catalogId?: string;
  parsed: ParsedManifestResult;
  requiredSkill?: string;
  discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  const state = hasError || parsed.manifest === undefined ? 'error' : 'ok';
  if (input.requiredSkill !== undefined && state === 'error') {
    const message =
      parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
      'manifest is unavailable';
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin "${input.id}" has an unhealthy manifest: ${message}`,
      { details: { pluginId: input.id, diagnostics: parsed.diagnostics } },
    );
  }
  const discovered = await discoverPluginSkills(input.id, parsed.manifest, input.discoverSkills);
  if (
    input.requiredSkill !== undefined &&
    !discovered.skills.some(
      (skill) => skill.name === input.requiredSkill && skill.plugin?.id === input.id,
    )
  ) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin "${input.id}" does not provide required skill "${input.requiredSkill}"`,
      {
        details: {
          pluginId: input.id,
          requiredSkill: input.requiredSkill,
          discoveredSkills: discovered.skills.map((skill) => skill.name),
        },
      },
    );
  }
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    origin: input.origin,
    catalogId: input.catalogId,
    enabled: input.enabled,
    state,
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    skills: discovered.skills.map((skill) => {
      const override = parsed.manifest?.interface?.skillOverrides?.[path.basename(skill.dir)];
      return {
        name: skill.name,
        displayName: override?.displayName,
        description: override?.description ?? skill.description,
        overrideKey: path.basename(skill.dir),
      };
    }),
    skillCount: discovered.skills.length,
    manifest: parsed.manifest,
    interfaceLocales: parsed.interfaceLocales,
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
    origin: record.origin,
    catalogId: record.catalogId,
    installedAt: record.installedAt,
    originalSource: record.originalSource,
    github: record.github,
  };
}

function recordToInfo(record: PluginRecord, locale?: string): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    skills: pluginSkillsInfo(record, locale),
    mcpServers: pluginMcpServersInfo(record, locale),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

function pluginCapabilities(
  record: PluginInspection,
  locale?: string,
): PluginCapabilities {
  return {
    skills: pluginSkillsInfo(record, locale),
    mcpServers: pluginMcpServersInfo(record, locale),
  };
}

function pluginSkillsInfo(record: PluginInspection, locale?: string): readonly PluginSkillInfo[] {
  const localized = pluginInterfaceForLocale(record, locale);
  return (record.skills ?? []).map((skill) => {
    const override = localized?.skillOverrides?.[skill.overrideKey];
    return {
      name: skill.name,
      displayName: override?.displayName ?? skill.displayName,
      description: override?.description ?? skill.description,
    };
  });
}

function pluginInterfaceForLocale(record: PluginInspection, locale?: string): PluginInterface | undefined {
  if (locale === undefined) return undefined;
  const normalized = normalizedLocale(locale);
  const base = normalized.split('-')[0];
  const candidates = base === normalized ? [normalized] : [normalized, base];
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(record.interfaceLocales ?? {})) {
      const normalizedKey = normalizedLocale(key);
      if (normalizedKey === candidate || normalizedKey.split('-')[0] === candidate) return value;
    }
  }
  return undefined;
}

function normalizedLocale(value: string): string {
  return value.replaceAll('_', '-').toLowerCase();
}

function isMcpServerEnabled(record: PluginInspection, name: string, config: McpServerConfig): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginInspection, locale?: string): readonly PluginMcpServerInfo[] {
  const localized = pluginInterfaceForLocale(record, locale);
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config, localized))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginInspection,
  name: string,
  config: McpServerConfig,
  localized?: PluginInterface,
): PluginMcpServerInfo {
  const baseOverride = record.manifest?.interface?.mcpOverrides?.[name];
  const override = localized?.mcpOverrides?.[name];
  const presentation = {
    displayName: override?.displayName ?? baseOverride?.displayName,
    description: override?.description ?? baseOverride?.description,
    iconUrl: override?.iconUrl ?? baseOverride?.iconUrl,
  };
  if (config.transport === 'http' || config.transport === 'sse') {
    return {
      name,
      ...presentation,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: config.transport,
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    ...presentation,
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
  return !path.basename(process.execPath).toLowerCase().startsWith('node');
}

async function discoverPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
  discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>,
): Promise<SkillDiscoveryResult> {
  const dirs = manifest?.skills ?? [];
  if (dirs.length === 0) {
    return { skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] };
  }
  const roots: SkillRoot[] = dirs.map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
    scanMode: manifest?.rootSkillFallback ? 'root-skill-only' : undefined,
  }));
  return discoverSkills(roots);
}
