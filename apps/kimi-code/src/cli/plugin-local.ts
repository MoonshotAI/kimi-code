/**
 * Local plugin read surface for the session engine — replaces the node-sdk
 * `PluginManager` (G-1 consumption switch). Only the three methods the engine
 * bridge consumes are ported (`load` / `enabledMcpServers` / `enabledHooks`),
 * with the same installed.json layout and runtime-rewrite rules (namespaced
 * server names, cwd/env injection, `node` fallback for single-binary builds).
 * Manifest parsing is lenient: a plugin with an unreadable manifest is simply
 * skipped, matching the SDK's error state.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { HookDefInput } from './native-server-client';
import type { McpServerConfigEntry } from './mcp-local';

const KIMI_PLUGIN_ROOT_PATH = 'kimi.plugin.json';
const KIMI_PLUGIN_DIR_PATH = '.kimi-plugin/plugin.json';

// Hidden Kimi CLI subcommand that re-enters as a Node interpreter. Used as
// fallback when an MCP server declares `"command": "node"` but the user is
// running a single-binary Kimi build that doesn't have `node` on PATH.
const KIMI_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

interface PluginCapabilityState {
  mcpServers?: Record<string, { enabled?: boolean }>;
}

interface InstalledRecord {
  id: string;
  root: string;
  enabled: boolean;
  capabilities?: PluginCapabilityState;
}

interface InstalledFile {
  version?: number;
  plugins?: InstalledRecord[];
}

interface PluginManifest {
  mcpServers?: Record<string, unknown>;
  hooks?: Array<{ event: string; matcher?: string; command: string; timeout?: number }>;
}

interface PluginRecord {
  id: string;
  root: string;
  enabled: boolean;
  state: 'ok' | 'error';
  manifest?: PluginManifest;
  capabilities?: PluginCapabilityState;
}

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
}

export class PluginManager {
  private readonly kimiHomeDir: string;
  private records: PluginRecord[] = [];

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.kimiHomeDir);
    const records: PluginRecord[] = [];
    for (const entry of file.plugins ?? []) {
      const manifest = await parseManifest(entry.root);
      records.push({
        id: entry.id,
        root: entry.root,
        enabled: entry.enabled,
        state: manifest === undefined ? 'error' : 'ok',
        manifest,
        capabilities: entry.capabilities,
      });
    }
    this.records = records;
  }

  enabledMcpServers(): Record<string, McpServerConfigEntry> {
    const out: Record<string, McpServerConfigEntry> = {};
    for (const record of this.records) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        const entry = config as McpServerConfigEntry;
        if (!isMcpServerEnabled(record, name, entry)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          { ...entry, enabled: true },
          record.root,
          this.kimiHomeDir,
        );
      }
    }
    return out;
  }

  enabledHooks(): readonly HookDefInput[] {
    const out: HookDefInput[] = [];
    for (const record of this.records) {
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
}

async function readInstalled(kimiHomeDir: string): Promise<InstalledFile> {
  const filePath = join(kimiHomeDir, 'plugins', 'installed.json');
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { version: 1, plugins: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed['plugins'])) {
    throw new Error('installed.json is not a valid InstalledFile object');
  }
  return {
    version: parsed['version'] as number | undefined,
    plugins: parsed['plugins'] as InstalledRecord[],
  };
}

async function parseManifest(pluginRoot: string): Promise<PluginManifest | undefined> {
  const rootJsonPath = join(pluginRoot, KIMI_PLUGIN_ROOT_PATH);
  const dirJsonPath = join(pluginRoot, KIMI_PLUGIN_DIR_PATH);
  const rootText = await readJsonIfFile(rootJsonPath);
  const dirText = rootText === undefined ? await readJsonIfFile(dirJsonPath) : undefined;
  const raw = rootText ?? dirText;
  if (raw === undefined) return undefined;

  const mcpServers = raw['mcpServers'];
  const hooks = raw['hooks'];
  return {
    mcpServers: isRecord(mcpServers) ? (mcpServers as Record<string, unknown>) : undefined,
    hooks: Array.isArray(hooks) ? (hooks as PluginManifest['hooks']) : undefined,
  };
}

async function readJsonIfFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : undefined;
}

function isMcpServerEnabled(
  record: PluginRecord,
  name: string,
  config: McpServerConfigEntry,
): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  // Plugin ids cannot contain ":", so this keeps plugin/server pairs unambiguous
  // even when either side contains "-".
  return `plugin-${pluginId}:${serverName}`;
}

function withPluginMcpRuntime(
  config: McpServerConfigEntry,
  pluginRoot: string,
  kimiHomeDir: string,
): McpServerConfigEntry {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code: unknown }).code === 'ENOENT' || (error as { code: unknown }).code === 'ENOTDIR')
  );
}
