import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  computeUpdateStatus,
  loadPluginMarketplace,
  type PluginMarketplace,
} from '#/utils/plugin-marketplace';
import {
  readPluginUpdateNoticeState,
  writePluginUpdateNoticeState,
} from '#/utils/plugin-update-notice-state';

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

function mcpToolServerSegment(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_NAME_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_TOOL_NAME_PREFIX.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
}

/**
 * Shows a one-time "update detected" notice for outdated plugins. Callers
 * report completed plugin usage (a plugin MCP tool name, or the plugin id of
 * a `/<plugin>:<command>` turn — both reported once the turn's output has
 * ended); the notifier checks the marketplace and persists the last notified
 * version, so a plugin is re-notified only when the marketplace advertises a
 * newer version than the one already shown.
 *
 * All entry points are fire-and-forget: the notice is a background nicety and
 * any failure (offline marketplace, missing state file, …) is swallowed.
 */
export class PluginUpdateNotifier {
  private marketplacePromise: Promise<PluginMarketplace> | undefined;
  private mcpServerPluginIds: Map<string, string> | undefined;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PluginUpdateNotifierDeps) {}

  handleMcpToolCompleted(toolName: string): void {
    // Cheap bail before touching the RPC layer — most tools are not MCP tools,
    // let alone plugin ones.
    if (!isPluginMcpToolName(toolName)) return;
    void this.resolvePluginId(toolName)
      .then((pluginId) => (pluginId === undefined ? undefined : this.checkAndNotify(pluginId)))
      .catch(() => {});
  }

  handlePluginCommandCompleted(pluginId: string): void {
    void this.checkAndNotify(pluginId).catch(() => {});
  }

  private async resolvePluginId(toolName: string): Promise<string | undefined> {
    const segment = mcpToolServerSegment(toolName);
    if (segment === undefined) return undefined;
    return (await this.getMcpServerPluginIds()).get(segment);
  }

  private async getMcpServerPluginIds(): Promise<Map<string, string>> {
    if (this.mcpServerPluginIds !== undefined) return this.mcpServerPluginIds;
    const map = new Map<string, string>();
    const session = this.deps.getSession();
    if (session !== undefined) {
      const servers = await session.listMcpServers();
      for (const server of servers) {
        const match = PLUGIN_MCP_RUNTIME_NAME.exec(server.name);
        if (match?.[1] !== undefined) {
          map.set(sanitizeMcpServerName(server.name), match[1]);
        }
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
      const entry = marketplace.plugins.find((plugin) => plugin.id === pluginId);
      if (entry === undefined) return;
      const installed = (await session.listPlugins()).find((plugin) => plugin.id === pluginId);
      if (installed === undefined) return;
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
