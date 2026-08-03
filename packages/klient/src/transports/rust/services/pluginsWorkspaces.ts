/**
 * `pluginsWorkspaces` — G5 service group for the rust transport:
 * `pluginService` + `workspaceService` + `hostFolderBrowser`.
 *
 * The plugin read surface (listPlugins / getPluginInfo / listPluginCommands)
 * is engine-backed: rust-loop `pluginList` / `pluginGet` (the engine tracks
 * plugin state in its own SQLite store; it exposes no install/remove/enable
 * RPCs). The plugin management surface (setPluginEnabled /
 * setPluginMcpServerEnabled / removePlugin / reloadPlugins) is host-backed:
 * it drives the node-sdk `PluginManager` read surface against the legacy
 * `~/.kimi-code/plugins/installed.json` registry (the same file the retired
 * agent-core manager owned). installPlugin / checkUpdates have no engine or
 * SDK capability (the SDK host explicitly does not port the archive
 * download/extract pipeline), so they surface a clear RPCError instead of
 * failing silently.
 *
 * `workspaceService` is a thin host port of the retired agent-core v2
 * workspace domain: a durable `<homeDir>/workspaces.json` catalog
 * (`{ version, workspaces: { [id]: entry }, deleted_workspace_ids }`,
 * v1-compatible) with a once-per-process merge from the legacy
 * `session_index.jsonl`, identity folding for one directory under several
 * spellings, soft delete with tombstones, and `createOrTouch`'s
 * root-exists contract.
 *
 * `hostFolderBrowser` browses the real local filesystem through `node:fs`
 * (realpath resolution, directory-only entries, dot-last sorting) and
 * derives `recent_roots` from the workspace registry.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { PluginManager } from '@moonshot-ai/kimi-code-sdk';

import { registerService } from '../router.js';
import { RPCError, type RustCallContext, type RustServiceRegistry } from '../types.js';

// ── Wire error codes (protocol/src/error-codes.ts) ────────────────────────
const REQUEST_INVALID = 40001;
const FS_PATH_NOT_FOUND = 40409;
const FS_PERMISSION_DENIED = 40411;
const INTERNAL_ERROR = 50001;

const RECENT_ROOTS_LIMIT = 8;

// ═══════════════════════════════════════════════════════════════════════════
// workspaceService — host workspace registry (thin port of agent-core-v2
// `app/workspace/*`; see `_base/utils/workdir-slug.ts` for the id helpers)
// ═══════════════════════════════════════════════════════════════════════════

interface WorkspaceRecord {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

interface WorkspaceCatalog {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly deletedIds: readonly string[];
}

interface SessionIndexLine {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly workDir: string;
}

const WORKSPACE_CATALOG_VERSION = 1;
const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

// Windows-shaped: drive-letter (C:\, C:/) or UNC (\\host\share, //host/share).
// Shape-based detection (not process.platform) keeps tests and remote hosts
// folding the same way regardless of host OS.
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

function workspaceRootKey(root: string): string {
  const slashed = root.replace(/\\/g, '/');
  // Test the shape BEFORE stripping trailing separators: a drive root
  // (`C:\`) loses its only separator to the strip (`C:`) and would no
  // longer read as Windows-shaped, escaping the case-fold.
  const shaped = WIN_SHAPED.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}

function dedupeByRoot(byId: ReadonlyMap<string, WorkspaceRecord>): WorkspaceRecord[] {
  const byRoot = new Map<string, WorkspaceRecord>();
  for (const ws of byId.values()) {
    const rootKey = workspaceRootKey(ws.root);
    const existing = byRoot.get(rootKey);
    if (existing === undefined) {
      byRoot.set(rootKey, ws);
      continue;
    }
    const canonicalId = encodeWorkDirKey(ws.root);
    if (existing.id !== canonicalId && ws.id === canonicalId) {
      byRoot.set(rootKey, ws);
    }
  }
  return [...byRoot.values()];
}

function collectAliasIds(
  workspaces: readonly WorkspaceRecord[],
  sessionIndexEntries: readonly SessionIndexLine[],
  root: string,
): string[] {
  const rootKey = workspaceRootKey(root);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ws of workspaces) {
    if (workspaceRootKey(ws.root) === rootKey && !seen.has(ws.id)) {
      seen.add(ws.id);
      ids.push(ws.id);
    }
  }
  for (const line of sessionIndexEntries) {
    if (workspaceRootKey(line.workDir) === rootKey) {
      const id = encodeWorkDirKey(line.workDir);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function parseSessionIndexLine(line: string): SessionIndexLine | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as Partial<SessionIndexLine>;
    if (
      typeof entry.sessionId !== 'string' ||
      typeof entry.sessionDir !== 'string' ||
      typeof entry.workDir !== 'string'
    ) {
      return undefined;
    }
    return { sessionId: entry.sessionId, sessionDir: entry.sessionDir, workDir: entry.workDir };
  } catch {
    return undefined;
  }
}

async function readSessionIndexEntries(homeDir: string): Promise<SessionIndexLine[]> {
  let text: string;
  try {
    text = await readFile(join(homeDir, 'session_index.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const entries: SessionIndexLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const entry = parseSessionIndexLine(trimmed);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

interface PersistedWorkspaceEntry {
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
}

function sanitizeEntry(value: unknown): PersistedWorkspaceEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<PersistedWorkspaceEntry>;
  if (
    typeof v.root !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.created_at !== 'string' ||
    typeof v.last_opened_at !== 'string'
  ) {
    return null;
  }
  return {
    root: v.root,
    name: v.name,
    created_at: v.created_at,
    last_opened_at: v.last_opened_at,
  };
}

function parseTime(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Read the catalog; a missing or malformed file is "no usable catalog"
 *  (mirrors the v1 tolerant read) and triggers the session-index rebuild. */
async function loadCatalogFile(homeDir: string): Promise<WorkspaceCatalog | undefined> {
  let text: string;
  try {
    text = await readFile(join(homeDir, 'workspaces.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as {
      workspaces?: Record<string, unknown>;
      deleted_workspace_ids?: unknown;
    };
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.workspaces !== 'object' ||
      parsed.workspaces === null
    ) {
      return undefined;
    }
    const now = Date.now();
    const workspaces: WorkspaceRecord[] = [];
    for (const [id, raw] of Object.entries(parsed.workspaces)) {
      const entry = sanitizeEntry(raw);
      if (entry === null) continue;
      workspaces.push({
        id,
        root: entry.root,
        name: entry.name,
        createdAt: parseTime(entry.created_at, now),
        lastOpenedAt: parseTime(entry.last_opened_at, now),
      });
    }
    const rawDeleted = parsed.deleted_workspace_ids;
    const deletedIds = Array.isArray(rawDeleted)
      ? rawDeleted.filter((id): id is string => typeof id === 'string')
      : [];
    return { workspaces, deletedIds };
  } catch {
    return undefined;
  }
}

async function saveCatalog(homeDir: string, catalog: WorkspaceCatalog): Promise<void> {
  const record: Record<string, PersistedWorkspaceEntry> = {};
  for (const ws of catalog.workspaces) {
    record[ws.id] = {
      root: ws.root,
      name: ws.name,
      created_at: new Date(ws.createdAt).toISOString(),
      last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
    };
  }
  const final = join(homeDir, 'workspaces.json');
  await mkdir(dirname(final), { recursive: true });
  // Unique tmp name: concurrent writers must not share one tmp path, or the
  // later rename fails with ENOENT once the earlier writer moves it into place.
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      { version: WORKSPACE_CATALOG_VERSION, workspaces: record, deleted_workspace_ids: [...catalog.deletedIds] },
      null,
      2,
    ),
    'utf8',
  );
  await rename(tmp, final);
}

/**
 * Process-wide catalog of known workspaces, durable in `<homeDir>/workspaces.json`.
 * No in-process write cache: every operation is a fresh read-modify-write,
 * serialized through a promise-chain mutex (the same file is written by other
 * processes, so a write-through cache would clobber external additions).
 * The once-per-process session-index sync mirrors agent-core-v2: rebuild from
 * `session_index.jsonl` when no usable catalog exists, otherwise merge only
 * workDirs the catalog does not know about (tombstoned ids stay deleted).
 */
class WorkspaceRegistry {
  private readonly homeDir: string;
  private merged = false;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }

  async list(): Promise<WorkspaceRecord[]> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = (await loadCatalogFile(this.homeDir)) ?? { workspaces: [], deletedIds: [] };
      return dedupeByRoot(new Map(catalog.workspaces.map((ws) => [ws.id, ws])));
    });
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = (await loadCatalogFile(this.homeDir)) ?? { workspaces: [], deletedIds: [] };
      return catalog.workspaces.find((ws) => ws.id === id);
    });
  }

  async createOrTouch(root: string, name?: string): Promise<WorkspaceRecord> {
    return this.runExclusive(async () => {
      await this.assertRootIsDirectory(root);
      await this.ensureMerged();
      const catalog = (await loadCatalogFile(this.homeDir)) ?? { workspaces: [], deletedIds: [] };
      const byId = new Map(catalog.workspaces.map((ws) => [ws.id, ws]));
      const deletedIds = new Set(catalog.deletedIds);
      const id = encodeWorkDirKey(root);
      let existing = byId.get(id);
      if (existing === undefined) {
        // Fold identity-equivalent spellings (Windows drive-letter/realpath
        // casing, slash direction) onto the registered entry.
        const rootKey = workspaceRootKey(root);
        for (const entry of byId.values()) {
          if (workspaceRootKey(entry.root) === rootKey) {
            existing = entry;
            break;
          }
        }
      }
      const now = Date.now();
      const ws: WorkspaceRecord =
        existing !== undefined
          ? { ...existing, lastOpenedAt: now }
          : { id, root, name: name ?? basename(root), createdAt: now, lastOpenedAt: now };
      byId.set(ws.id, ws);
      // An explicit add clears any prior deletion tombstone.
      deletedIds.delete(ws.id);
      await saveCatalog(this.homeDir, { workspaces: [...byId.values()], deletedIds: [...deletedIds] });
      return ws;
    });
  }

  async update(id: string, patch: { name?: string }): Promise<WorkspaceRecord | undefined> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = (await loadCatalogFile(this.homeDir)) ?? { workspaces: [], deletedIds: [] };
      const existing = catalog.workspaces.find((ws) => ws.id === id);
      if (existing === undefined) return undefined;
      const updated: WorkspaceRecord =
        patch.name !== undefined ? { ...existing, name: patch.name } : existing;
      await saveCatalog(this.homeDir, {
        workspaces: catalog.workspaces.map((ws) => (ws.id === id ? updated : ws)),
        deletedIds: catalog.deletedIds,
      });
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureMerged();
      const catalog = (await loadCatalogFile(this.homeDir)) ?? { workspaces: [], deletedIds: [] };
      // Soft delete: tombstone the id so the session-index merge cannot
      // resurrect it. Folded aliases must die with it.
      let root = catalog.workspaces.find((ws) => ws.id === id)?.root;
      if (root === undefined) {
        // Derived/unknown id: recover its spelling from the session index so
        // the whole alias set can still be tombstoned.
        root = (await readSessionIndexEntries(this.homeDir)).find(
          (line) => encodeWorkDirKey(line.workDir) === id,
        )?.workDir;
      }
      if (root === undefined) {
        await saveCatalog(this.homeDir, {
          workspaces: catalog.workspaces.filter((ws) => ws.id !== id),
          deletedIds: [...new Set([...catalog.deletedIds, id])],
        });
        return;
      }
      const rootKey = workspaceRootKey(root);
      const aliasIds = collectAliasIds(
        catalog.workspaces,
        await readSessionIndexEntries(this.homeDir),
        root,
      );
      await saveCatalog(this.homeDir, {
        workspaces: catalog.workspaces.filter((ws) => workspaceRootKey(ws.root) !== rootKey),
        deletedIds: [...new Set([...catalog.deletedIds, ...aliasIds])],
      });
    });
  }

  /** `createOrTouch` root contract: the root must be an existing directory. */
  private async assertRootIsDirectory(root: string): Promise<void> {
    let rootStat;
    try {
      rootStat = await stat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new RPCError(FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
      }
      throw error;
    }
    if (rootStat.isDirectory()) return;
    // The probe follows symlinks; a symlink-form root is re-checked through
    // realpath while the workspace identity stays lexical.
    try {
      const real = await realpath(root);
      if ((await stat(real)).isDirectory()) return;
    } catch {
      // fall through to the not-a-directory error below
    }
    throw new RPCError(FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
  }

  /** Once-per-process startup sync with the legacy session index. Runs inside
   *  the op mutex, so it cannot interleave with a mutation's read-modify-write. */
  private async ensureMerged(): Promise<void> {
    if (this.merged) return;
    const loaded = await loadCatalogFile(this.homeDir);
    if (loaded === undefined) {
      const rebuilt = await this.rebuildFromSessionIndex();
      await saveCatalog(this.homeDir, { workspaces: [...rebuilt.values()], deletedIds: [] });
      this.merged = true;
      return;
    }
    const byId = new Map(loaded.workspaces.map((ws) => [ws.id, ws]));
    const deletedIds = new Set(loaded.deletedIds);
    if (await this.mergeFromSessionIndex(byId, deletedIds)) {
      await saveCatalog(this.homeDir, { workspaces: [...byId.values()], deletedIds: [...deletedIds] });
    }
    this.merged = true;
  }

  private async mergeFromSessionIndex(
    byId: Map<string, WorkspaceRecord>,
    deletedIds: ReadonlySet<string>,
  ): Promise<boolean> {
    let changed = false;
    const now = Date.now();
    for (const workDir of (await readSessionIndexEntries(this.homeDir))
      .map((entry) => entry.workDir)
      .filter((workDir) => isAbsolute(workDir))) {
      const id = encodeWorkDirKey(workDir);
      if (byId.has(id) || deletedIds.has(id)) continue;
      byId.set(id, { id, root: workDir, name: basename(workDir), createdAt: now, lastOpenedAt: now });
      changed = true;
    }
    return changed;
  }

  private async rebuildFromSessionIndex(): Promise<Map<string, WorkspaceRecord>> {
    const result = new Map<string, WorkspaceRecord>();
    const now = Date.now();
    // Dedupe by identity key, not by minted id: casing/slash variants of one
    // directory collapse here too. First seen wins.
    const seenRootKeys = new Set<string>();
    for (const entry of await readSessionIndexEntries(this.homeDir)) {
      if (!isAbsolute(entry.workDir)) continue;
      const rootKey = workspaceRootKey(entry.workDir);
      if (seenRootKeys.has(rootKey)) continue;
      seenRootKeys.add(rootKey);
      const id = encodeWorkDirKey(entry.workDir);
      result.set(id, { id, root: entry.workDir, name: basename(entry.workDir), createdAt: now, lastOpenedAt: now });
    }
    return result;
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const workspaceRegistries = new Map<string, WorkspaceRegistry>();

function workspaceRegistryFor(homeDir: string): WorkspaceRegistry {
  let registry = workspaceRegistries.get(homeDir);
  if (registry === undefined) {
    registry = new WorkspaceRegistry(homeDir);
    workspaceRegistries.set(homeDir, registry);
  }
  return registry;
}

const workspaceService: RustServiceRegistry = {
  async list(ctx) {
    return workspaceRegistryFor(ctx.host.homeDir).list();
  },
  async get(ctx) {
    return workspaceRegistryFor(ctx.host.homeDir).get(ctx.args[0] as string);
  },
  async createOrTouch(ctx) {
    const root = ctx.args[0] as string;
    const name = ctx.args[1] as string | undefined;
    return workspaceRegistryFor(ctx.host.homeDir).createOrTouch(root, name);
  },
  async update(ctx) {
    const id = ctx.args[0] as string;
    const patch = ctx.args[1] as { name?: string };
    return workspaceRegistryFor(ctx.host.homeDir).update(id, patch);
  },
  async delete(ctx) {
    return workspaceRegistryFor(ctx.host.homeDir).delete(ctx.args[0] as string);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// pluginService — engine-backed reads + host-backed management
// ═══════════════════════════════════════════════════════════════════════════

// Engine wire shapes (rust-loop `EnginePluginSummary` / `EnginePluginInfo`;
// serde snake_case, `Option` fields may arrive as `null`).
interface EnginePluginSummaryLike {
  id: string;
  display_name?: string | null;
  version?: string | null;
  enabled?: boolean;
  state?: string | null;
  skill_count?: number;
  mcp_server_count?: number;
  enabled_mcp_server_count?: number;
  hook_count?: number;
  command_count?: number;
  has_errors?: boolean;
  source?: string | null;
}

interface EngineMcpServerLike {
  name?: string | null;
  runtime_name?: string | null;
  enabled?: boolean;
  transport?: string | null;
  command?: string | null;
  url?: string | null;
}

interface EnginePluginInfoLike extends EnginePluginSummaryLike {
  root?: string | null;
  installed_at?: string | null;
  mcp_servers?: readonly EngineMcpServerLike[] | null;
  diagnostics?: ReadonlyArray<{ severity?: string | null; message?: string | null }> | null;
}

interface PluginCommandDef {
  pluginId: string;
  name: string;
  description: string;
  body: string;
  path: string;
}

function stringOrUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}

function toPluginSource(source: string | null | undefined): 'local-path' | 'zip-url' | 'github' {
  return source === 'zip-url' || source === 'github' ? source : 'local-path';
}

function normalizeTransport(transport: string | null | undefined): 'stdio' | 'http' | 'sse' {
  return transport === 'http' || transport === 'sse' ? transport : 'stdio';
}

function toPluginSummary(summary: EnginePluginSummaryLike): Record<string, unknown> {
  return {
    id: summary.id,
    displayName: stringOrUndefined(summary.display_name) ?? summary.id,
    version: stringOrUndefined(summary.version),
    enabled: summary.enabled === true,
    state: summary.state === 'error' ? 'error' : 'ok',
    skillCount: summary.skill_count ?? 0,
    mcpServerCount: summary.mcp_server_count ?? 0,
    enabledMcpServerCount: summary.enabled_mcp_server_count ?? 0,
    hookCount: summary.hook_count ?? 0,
    commandCount: summary.command_count ?? 0,
    hasErrors: summary.has_errors === true,
    source: toPluginSource(summary.source),
  };
}

function toMcpServerInfo(server: EngineMcpServerLike): Record<string, unknown> {
  return {
    name: stringOrUndefined(server.name) ?? '',
    runtimeName: stringOrUndefined(server.runtime_name) ?? server.name ?? '',
    enabled: server.enabled === true,
    transport: normalizeTransport(server.transport),
    command: stringOrUndefined(server.command),
    url: stringOrUndefined(server.url),
  };
}

function toPluginInfo(info: EnginePluginInfoLike): Record<string, unknown> {
  return {
    ...toPluginSummary(info),
    root: stringOrUndefined(info.root) ?? '',
    installedAt: stringOrUndefined(info.installed_at) ?? '',
    mcpServers: (info.mcp_servers ?? []).map(toMcpServerInfo),
    diagnostics: (info.diagnostics ?? []).map((diagnostic) => ({
      severity:
        diagnostic.severity === 'warn' || diagnostic.severity === 'info'
          ? diagnostic.severity
          : 'error',
      message: stringOrUndefined(diagnostic.message) ?? '',
    })),
  };
}

// ── listPluginCommands: engine-listed plugins + manifest-derived commands ──
// The engine tracks no command bodies (its summary hardcodes command_count 0),
// so command defs are derived from each engine-listed plugin's on-disk
// manifest at `root` — a thin port of the retired manifest `commands` reading
// plus the frontmatter parse (`agent-core-v2/app/plugin/commands.ts`).

async function readPluginManifest(pluginRoot: string): Promise<Record<string, unknown> | undefined> {
  for (const rel of ['kimi.plugin.json', '.kimi-plugin/plugin.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(pluginRoot, rel), 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function commandNameFromFile(file: string, root: string): string {
  const rel = relative(root, file).replace(/\.md$/i, '');
  return rel.split(/[\\/]/).join('/');
}

async function listMarkdownFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkMarkdown(root, root, out);
  return out;
}

async function walkMarkdown(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
}

/** Minimal frontmatter reader (no YAML dependency): extracts the leading
 *  `---` fenced block and parses simple `key: value` scalar lines. */
function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: out, body: text };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { frontmatter: out, body: text };
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && value !== '') out[key] = value;
  }
  return { frontmatter: out, body: lines.slice(close + 1).join('\n') };
}

function descriptionFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return 'No description provided.';
  return firstLine.length > 240 ? `${firstLine.slice(0, 239)}…` : firstLine;
}

function parseCommandText(input: {
  text: string;
  commandPath: string;
  pluginId: string;
  fallbackName: string;
}): PluginCommandDef {
  const { frontmatter, body } = splitFrontmatter(input.text);
  return {
    pluginId: input.pluginId,
    name: frontmatter['name'] ?? input.fallbackName,
    description: frontmatter['description'] ?? descriptionFromBody(body),
    body: body.trim(),
    path: resolve(input.commandPath),
  };
}

async function loadPluginCommandFile(
  commandPath: string,
  pluginId: string,
  fallbackName: string,
): Promise<PluginCommandDef | undefined> {
  try {
    const text = await readFile(commandPath, 'utf8');
    return parseCommandText({ text, commandPath, pluginId, fallbackName });
  } catch {
    return undefined;
  }
}

async function readPluginManifestCommands(
  pluginRoot: string,
  pluginId: string,
): Promise<PluginCommandDef[]> {
  const manifest = await readPluginManifest(pluginRoot);
  if (manifest === undefined) return [];
  const rawCommands = manifest['commands'];
  if (rawCommands === undefined) return [];
  const entries: string[] = [];
  if (typeof rawCommands === 'string') {
    entries.push(rawCommands);
  } else if (Array.isArray(rawCommands) && rawCommands.every((entry) => typeof entry === 'string')) {
    entries.push(...(rawCommands as string[]));
  } else {
    return [];
  }
  const out: PluginCommandDef[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) continue;
    const absolute = resolve(pluginRoot, entry);
    if (!isWithin(absolute, pluginRoot)) continue;
    if (await isDirectory(absolute)) {
      for (const file of await listMarkdownFilesRecursive(absolute)) {
        const def = await loadPluginCommandFile(file, pluginId, commandNameFromFile(file, absolute));
        if (def !== undefined) out.push(def);
      }
    } else if ((await isFile(absolute)) && absolute.endsWith('.md')) {
      const def = await loadPluginCommandFile(
        absolute,
        pluginId,
        commandNameFromFile(absolute, dirname(absolute)),
      );
      if (def !== undefined) out.push(def);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Host plugin management (node-sdk PluginManager over the legacy registry) ──

interface PluginHost {
  readonly manager: PluginManager;
  /** Resolves once the manager's `load()` finished; cleared on failure so a
   *  later call retries (mirrors the retired service's recoverable load). */
  loadPromise: Promise<void> | undefined;
  /** Serializes mutations (the manager keeps an in-memory record map). */
  queue: Promise<unknown>;
}

const pluginHosts = new Map<string, PluginHost>();

function getPluginHost(homeDir: string): PluginHost {
  let host = pluginHosts.get(homeDir);
  if (host === undefined) {
    host = { manager: new PluginManager({ kimiHomeDir: homeDir }), loadPromise: undefined, queue: Promise.resolve() };
    pluginHosts.set(homeDir, host);
  }
  return host;
}

function ensureLoaded(host: PluginHost): Promise<void> {
  host.loadPromise ??= host.manager.load().catch((error: unknown) => {
    // Keep the failure cached so serialized ops all see it, but clear the
    // cache so a later call (or reloadPlugins) can recover.
    host.loadPromise = undefined;
    throw error;
  });
  return host.loadPromise;
}

function enqueuePluginMutation<T>(host: PluginHost, op: () => Promise<T>): Promise<T> {
  const next = host.queue.then(op, op);
  host.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const pluginService: RustServiceRegistry = {
  async listPlugins(ctx) {
    const result = await ctx.rust.pluginList();
    return (result?.plugins ?? []).map(toPluginSummary);
  },

  async getPluginInfo(ctx) {
    const { id } = ctx.args[0] as { id: string };
    const info = await ctx.rust.pluginGet(id);
    if (info === null) {
      throw new RPCError(REQUEST_INVALID, `plugin not found: ${id}`);
    }
    return toPluginInfo(info);
  },

  async listPluginCommands(ctx) {
    const result = await ctx.rust.pluginList();
    const out: PluginCommandDef[] = [];
    for (const summary of result?.plugins ?? []) {
      const info = await ctx.rust.pluginGet(summary.id);
      if (info === null) continue;
      const root = stringOrUndefined(info.root);
      if (root === undefined || root === '') continue;
      out.push(...(await readPluginManifestCommands(root, summary.id)));
    }
    return out;
  },

  async installPlugin(ctx) {
    // No engine RPC and no SDK host pipeline (the node-sdk PluginManager
    // explicitly does not port archive download/extract). Surface a clear
    // error instead of failing silently.
    void ctx;
    throw new RPCError(
      INTERNAL_ERROR,
      'plugin install is not available under the rust SDK host; manage plugins through the CLI/daemon',
    );
  },

  async checkUpdates(ctx) {
    // No engine RPC and no ported github resolver on the SDK host.
    void ctx;
    throw new RPCError(
      INTERNAL_ERROR,
      'plugin update checks are not available under the rust SDK host; manage plugins through the CLI/daemon',
    );
  },

  async setPluginEnabled(ctx) {
    const input = ctx.args[0] as { id: string; enabled: boolean };
    const host = getPluginHost(ctx.host.homeDir);
    await enqueuePluginMutation(host, async () => {
      await ensureLoaded(host);
      await host.manager.setEnabled(input.id, input.enabled);
    });
  },

  async setPluginMcpServerEnabled(ctx) {
    const input = ctx.args[0] as { id: string; server: string; enabled: boolean };
    const host = getPluginHost(ctx.host.homeDir);
    await enqueuePluginMutation(host, async () => {
      await ensureLoaded(host);
      await host.manager.setMcpServerEnabled(input.id, input.server, input.enabled);
    });
  },

  async removePlugin(ctx) {
    const { id } = ctx.args[0] as { id: string };
    const host = getPluginHost(ctx.host.homeDir);
    await enqueuePluginMutation(host, async () => {
      await ensureLoaded(host);
      await host.manager.remove(id);
    });
  },

  async reloadPlugins(ctx) {
    const host = getPluginHost(ctx.host.homeDir);
    return enqueuePluginMutation(host, async () => {
      // reload() re-reads installed.json directly, so it recovers even when a
      // previous load() failed; mark the host loaded on success.
      const summary = await host.manager.reload();
      host.loadPromise = Promise.resolve();
      return summary;
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// hostFolderBrowser — real local filesystem browsing (node:fs)
// ═══════════════════════════════════════════════════════════════════════════

function mapFsError(err: unknown, path: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new RPCError(FS_PATH_NOT_FOUND, `path not found: ${path}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new RPCError(FS_PERMISSION_DENIED, `permission denied: ${path}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function compareBrowseEntries(a: { name: string }, b: { name: string }): number {
  const aDot = a.name.startsWith('.');
  const bDot = b.name.startsWith('.');
  if (aDot !== bDot) return aDot ? 1 : -1;
  return a.name.localeCompare(b.name);
}

const hostFolderBrowserService: RustServiceRegistry = {
  async browse(ctx) {
    const target = (ctx.args[0] as string | undefined) ?? homedir();
    if (!isAbsolute(target)) {
      throw new RPCError(REQUEST_INVALID, `path must be absolute: ${target}`);
    }
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      throw mapFsError(error, target);
    }
    let dirents;
    try {
      dirents = await readdir(realTarget, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, realTarget);
    }
    const entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(realTarget, d.name), is_dir: true as const }))
      .sort(compareBrowseEntries);
    const parent = dirname(realTarget);
    return { path: realTarget, parent: parent === realTarget ? null : parent, entries };
  },

  async home(ctx) {
    const home = homedir();
    const workspaces = await workspaceRegistryFor(ctx.host.homeDir).list();
    const recent_roots = workspaces.slice(0, RECENT_ROOTS_LIMIT).map((w) => w.root);
    return { home, recent_roots };
  },
};

registerService('pluginService', pluginService);
registerService('workspaceService', workspaceService);
registerService('hostFolderBrowser', hostFolderBrowserService);
