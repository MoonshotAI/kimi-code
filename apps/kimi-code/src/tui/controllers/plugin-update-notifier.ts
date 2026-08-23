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
import { isOfficialPluginInstall } from '../utils/plugin-source-label';

/**
 * The slice of the SDK session the notifier reads. Structurally satisfied by
 * the full SDK `Session`, and easy to fake in tests.
 */
export interface PluginUpdateNotifierSession {
  listMcpServers(): Promise<readonly { name: string }[]>;
  listPlugins(): Promise<readonly PluginSummary[]>;
}

export interface PluginUpdateNotifierDeps {
  readonly getSession: () => PluginUpdateNotifierSession | undefined;
  readonly workDir: string;
  readonly notify: (message: string) => void;
  /** Overridable for tests; defaults to the shared marketplace loader. */
  readonly loadMarketplace?: () => Promise<PluginMarketplace>;
  /** Overridable for tests; defaults to the updates dir under the data dir. */
  readonly stateFile?: string;
}

const MCP_TOOL_NAME_PREFIX = 'mcp__';
const PLUGIN_MCP_TOOL_NAME_PREFIX = `${MCP_TOOL_NAME_PREFIX}plugin-`;
// Plugin MCP servers run under the runtime name `plugin-<id>:<server>`
// (pluginMcpRuntimeName in packages/agent-core/src/plugin/manager.ts).
const PLUGIN_MCP_RUNTIME_NAME = /^plugin-([a-z0-9][a-z0-9_-]{0,63}):/;

/** Cheap name check for plugin-provided MCP tools (`mcp__plugin-…`). */
export function isPluginMcpToolName(toolName: string): boolean {
  return toolName.startsWith(PLUGIN_MCP_TOOL_NAME_PREFIX);
}

/**
 * Mirror of sanitizeMcpNamePart in packages/agent-core/src/mcp/tool-naming.ts.
 * MCP tool names on the wire carry the sanitized server name; the collapse
 * step guarantees the `__` separator never appears inside a name part.
 */
function sanitizeMcpServerName(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

/**
 * Find the plugin behind a qualified MCP tool name by longest-prefix match
 * against known server names. Prefix matching (rather than splitting on the
 * `__` separator) survives core's 64-char truncation, which can cut the
 * separator before appending the hash suffix; the boundary check keeps a
 * shorter server name from matching another server's name, and longest match
 * wins when one server name is a prefix of another. A name truncated inside
 * the server part itself cannot be attributed reliably and stays unresolved.
 */
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

/**
 * Shows a one-time "update detected" notice for outdated plugins. Callers
 * report completed plugin usage (a plugin MCP tool name, or the plugin id of
 * a `/<plugin>:<command>` turn — both reported once the turn's output has
 * ended); the notifier checks the marketplace and persists the last notified
 * version, so a plugin is re-notified only when the marketplace advertises a
 * newer version than the one already shown.
 *
 * Entry points are fire-and-forget in production (never reject — the notice
 * is a background nicety and any failure, e.g. an offline marketplace, is
 * swallowed) and return an awaitable promise so tests can settle the queue
 * deterministically.
 */
export class PluginUpdateNotifier {
  private marketplacePromise: Promise<PluginMarketplace> | undefined;
  private mcpServerPluginIds: Map<string, string> | undefined;
  private readonly inFlight = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PluginUpdateNotifierDeps) {}

  handleMcpToolCompleted(toolName: string): Promise<void> {
    // Cheap bail before touching the RPC layer — most tools are not MCP tools,
    // let alone plugin ones.
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
    // Serialize the read-modify-write cycle on the notice state file: two
    // concurrent checks (e.g. a turn that used two outdated plugins) would
    // otherwise read the same snapshot and the last write would drop the
    // other plugin's entry.
    this.queue = this.queue.then(() => this.checkAndNotify(pluginId)).catch(() => {});
    return this.queue;
  }

  private async resolvePluginId(toolName: string): Promise<string | undefined> {
    const hit = matchPluginByToolName(toolName, await this.getMcpServerPluginIds());
    if (hit !== undefined) return hit;
    // The map is memoized, but this notifier is reused across /reload, /new,
    // and session switches, so plugins installed or enabled later in the same
    // app run are missing from it. Refresh once on a miss before giving up.
    return matchPluginByToolName(toolName, await this.loadMcpServerPluginIds());
  }

  private async getMcpServerPluginIds(): Promise<Map<string, string>> {
    if (this.mcpServerPluginIds !== undefined) return this.mcpServerPluginIds;
    return this.loadMcpServerPluginIds();
  }

  private async loadMcpServerPluginIds(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const session = this.deps.getSession();
    // Without a session there is nothing to list; leave the cache unset so
    // the next lookup retries instead of pinning an empty map.
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
      // Only the default official catalog can back an "Official Marketplace"
      // notice — a custom catalog (KIMI_CODE_PLUGIN_MARKETPLACE_URL) may
      // advertise anything under any id.
      if (marketplace.source !== kimiCodePluginMarketplaceUrl()) return;
      const entry = marketplace.plugins.find((plugin) => plugin.id === pluginId);
      if (entry === undefined) return;
      const installed = (await session.listPlugins()).find((plugin) => plugin.id === pluginId);
      if (installed === undefined) return;
      // Only official installs are tracked against the Official Marketplace —
      // a local/GitHub fork that happens to share a catalog id is not it.
      if (!isOfficialPluginInstall(installed)) return;
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
    // Cached for the app run; a failed fetch is retried on the next invocation.
    this.marketplacePromise ??= this.loadMarketplace().catch((error: unknown) => {
      this.marketplacePromise = undefined;
      throw error;
    });
    return this.marketplacePromise;
  }

  private loadMarketplace(): Promise<PluginMarketplace> {
    const load = this.deps.loadMarketplace;
    if (load !== undefined) return load();
    return loadPluginMarketplace({ workDir: this.deps.workDir });
  }
}
