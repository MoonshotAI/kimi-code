import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { kimiCodePluginMarketplaceUrl } from '#/constant/app';
import {
  computeUpdateStatus,
  loadPluginMarketplace,
  type PluginMarketplace,
} from '#/utils/plugin-marketplace';
import {
  readPluginUpdateNoticeState,
  writePluginUpdateNoticeState,
} from '#/utils/plugin-update-notice-state';
import {
  installedPluginForMarketplaceEntry,
  marketplaceEntryIdForInstalledPlugin,
} from '../utils/capability-marketplace';
import { isOfficialPluginInstall } from '../utils/plugin-source-label';

export interface PluginUpdateNotifierSession {
  listMcpServers(): Promise<readonly { name: string }[]>;
  listPlugins(): Promise<readonly PluginSummary[]>;
}

export interface PluginUpdateNotifierDeps {
  readonly getSession: () => PluginUpdateNotifierSession | undefined;
  readonly workDir: string;
  readonly notify: (message: string) => void;
  readonly loadMarketplace?: () => Promise<PluginMarketplace>;
  readonly reloadPlugins?: () => Promise<unknown>;
  readonly refreshPluginCommands?: () => Promise<unknown>;
  readonly stateFile?: string;
}

const MCP_TOOL_NAME_PREFIX = 'mcp__';
const PLUGIN_MCP_TOOL_NAME_PREFIX = `${MCP_TOOL_NAME_PREFIX}plugin-`;
const PLUGIN_MCP_RUNTIME_NAME = /^plugin-([a-z0-9][a-z0-9_-]{0,63}):/;

export function isPluginMcpToolName(toolName: string): boolean {
  return toolName.startsWith(PLUGIN_MCP_TOOL_NAME_PREFIX);
}

function sanitizeMcpServerName(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

function matchPluginByToolName(
  toolName: string,
  serverPluginIds: Map<string, string>,
): string | undefined {
  let best: string | undefined;
  let bestLength = 0;
  for (const [serverName, pluginId] of serverPluginIds) {
    const prefix = `${MCP_TOOL_NAME_PREFIX}${serverName}`;
    if (!toolName.startsWith(prefix)) continue;
    const boundary = toolName.charAt(prefix.length);
    if (boundary !== '' && boundary !== '_') continue;
    if (prefix.length > bestLength) {
      best = pluginId;
      bestLength = prefix.length;
    }
  }
  return best;
}

export class PluginUpdateNotifier {
  private marketplacePromise: Promise<PluginMarketplace> | undefined;
  private mcpServerPluginIds: Map<string, string> | undefined;
  private readonly inFlight = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PluginUpdateNotifierDeps) {}

  handleMcpToolCompleted(toolName: string): Promise<void> {
    if (!isPluginMcpToolName(toolName)) return Promise.resolve();
    return this.resolvePluginId(toolName)
      .then((pluginId) => {
        if (pluginId !== undefined) return this.enqueue(pluginId);
        return undefined;
      })
      .catch(() => {});
  }

  handlePluginCommandCompleted(pluginId: string): Promise<void> {
    return this.enqueue(pluginId);
  }

  private enqueue(pluginId: string): Promise<void> {
    this.queue = this.queue.then(() => this.checkAndNotify(pluginId)).catch(() => {});
    return this.queue;
  }

  private async resolvePluginId(toolName: string): Promise<string | undefined> {
    const hit = matchPluginByToolName(toolName, await this.getMcpServerPluginIds());
    if (hit !== undefined) return hit;
    return matchPluginByToolName(toolName, await this.loadMcpServerPluginIds());
  }

  private async getMcpServerPluginIds(): Promise<Map<string, string>> {
    if (this.mcpServerPluginIds !== undefined) return this.mcpServerPluginIds;
    return this.loadMcpServerPluginIds();
  }

  private async loadMcpServerPluginIds(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const session = this.deps.getSession();
    if (session === undefined) return map;
    const servers = await session.listMcpServers();
    for (const server of servers) {
      const match = PLUGIN_MCP_RUNTIME_NAME.exec(server.name);
      if (match?.[1] !== undefined) {
        map.set(sanitizeMcpServerName(server.name), match[1]);
      }
    }
    this.mcpServerPluginIds = map;
    return map;
  }

  private async checkAndNotify(pluginId: string): Promise<void> {
    if (this.inFlight.has(pluginId)) return;
    this.inFlight.add(pluginId);
    try {
      const session = this.deps.getSession();
      if (session === undefined) return;
      const marketplace = await this.loadCatalog();
      if (marketplace.source !== kimiCodePluginMarketplaceUrl()) return;
      const entryId = marketplaceEntryIdForInstalledPlugin(pluginId, true);
      const entry = marketplace.plugins.find((plugin) => plugin.id === entryId);
      if (entry === undefined) return;
      const installed = installedPluginForMarketplaceEntry(
        entry.id,
        await session.listPlugins(),
        undefined,
        true,
      );
      if (installed === undefined || installed.origin === 'custom') return;
      if (installed.origin === 'unknown' && !isOfficialPluginInstall(installed)) return;
      const status = computeUpdateStatus(entry.version, installed.version, true);
      if (status.kind !== 'update') return;
      const state = await readPluginUpdateNoticeState(this.deps.stateFile);
      if (state.notified[pluginId] === status.latest) return;
      this.deps.notify(
        `Update detected: ${installed.displayName} ${status.latest} is available. ` +
          'Run /plugins to install the latest version from the Official Marketplace.',
      );
      await writePluginUpdateNoticeState(
        { ...state, notified: { ...state.notified, [pluginId]: status.latest } },
        this.deps.stateFile,
      );
    } finally {
      this.inFlight.delete(pluginId);
    }
  }

  private loadCatalog(): Promise<PluginMarketplace> {
    this.marketplacePromise ??= this.loadMarketplace().catch((error: unknown) => {
      this.marketplacePromise = undefined;
      throw error;
    });
    return this.marketplacePromise;
  }

  private loadMarketplace(): Promise<PluginMarketplace> {
    const load = this.deps.loadMarketplace;
    if (load !== undefined) return load();
    return loadPluginMarketplace({
      workDir: this.deps.workDir,
      reconcileAvailability: async (changed) => {
        if (!changed) return;
        await this.deps.reloadPlugins?.();
        await this.deps.refreshPluginCommands?.();
      },
    });
  }
}
