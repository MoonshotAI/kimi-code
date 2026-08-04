/**
 * `mcp` domain — merged workspace + session MCP connection view.
 *
 * `MergedMcpConnectionView` presents one `McpConnectionView` over the
 * workspace handler's shared manager (the base) and a session-owned overlay
 * manager holding the session's ephemeral servers. The overlay owns the
 * names it was created with: reads (`list` / `get` / `resolved` /
 * `getRemoteServerUrl`) and mutations (`reconnect` / `reconnectAndJoin`)
 * route overlay names to the overlay manager — an ephemeral server shadows a
 * workspace server of the same name for this session — and base status
 * events for shadowed names are filtered out so consumers see exactly one
 * entry per name. Readiness and startup duration aggregate both managers.
 */

import type {
  McpConnectionManager,
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { abortable } from '#/_base/utils/abort';

export class MergedMcpConnectionView implements McpConnectionView {
  constructor(
    private readonly base: McpConnectionManager,
    private readonly overlay: McpConnectionManager,
    private readonly overlayNames: ReadonlySet<string>,
  ) {}

  get oauthService(): McpOAuthService | undefined {
    return this.overlay.oauthService ?? this.base.oauthService;
  }

  list(): readonly McpServerEntry[] {
    const baseEntries = this.base.list().filter((entry) => !this.overlayNames.has(entry.name));
    return [...baseEntries, ...this.overlay.list()];
  }

  get(name: string): McpServerEntry | undefined {
    return this.owner(name).get(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.owner(name).resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.owner(name).getRemoteServerUrl(name);
  }

  reconnect(name: string): Promise<void> {
    return this.owner(name).reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.owner(name).reconnectAndJoin(name);
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const both = Promise.all([
      this.base.waitForInitialLoad(),
      this.overlay.waitForInitialLoad(),
    ]).then(() => undefined);
    return signal === undefined ? both : abortable(both, signal);
  }

  initialLoadDurationMs(): number {
    return Math.max(this.base.initialLoadDurationMs(), this.overlay.initialLoadDurationMs());
  }

  onStatusChange(listener: McpStatusListener): () => void {
    const unsubscribeBase = this.base.onStatusChange((entry) => {
      if (!this.overlayNames.has(entry.name)) listener(entry);
    });
    const unsubscribeOverlay = this.overlay.onStatusChange(listener);
    return () => {
      unsubscribeBase();
      unsubscribeOverlay();
    };
  }

  private owner(name: string): McpConnectionManager {
    return this.overlayNames.has(name) ? this.overlay : this.base;
  }
}
