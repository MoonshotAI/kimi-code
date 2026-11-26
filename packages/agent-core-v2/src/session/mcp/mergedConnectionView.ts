import { ErrorCodes, Error2 } from '#/errors';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { abortable } from '#/_base/utils/abort';
import type {
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient } from '#/mcpCore/types';

export interface McpConnectionLayer {
  readonly id: string;
  readonly priority: number;
  readonly view: McpConnectionView;
}

export class MergedMcpConnectionView implements McpConnectionView, IDisposable {
  private layers: readonly McpConnectionLayer[] = [];
  private readonly subscriptions = new Map<string, IDisposable>();
  private readonly listeners = new Set<McpStatusListener>();
  private disposed = false;

  get oauthService(): McpOAuthService | undefined {
    for (const layer of this.layers) {
      if (layer.view.oauthService !== undefined) return layer.view.oauthService;
    }
    return undefined;
  }

  addLayer(layer: McpConnectionLayer): IDisposable {
    if (this.disposed) return toDisposable(() => {});
    this.removeLayer(layer.id);
    this.layers = [...this.layers, layer].toSorted((a, b) => b.priority - a.priority);
    const subscription = toDisposable(
      layer.view.onStatusChange((entry) => {
        if (this.owner(entry.name)?.id !== layer.id) return;
        for (const listener of Array.from(this.listeners)) listener(entry);
      }),
    );
    this.subscriptions.set(layer.id, subscription);
    return toDisposable(() => this.removeLayer(layer.id));
  }

  removeLayer(id: string): void {
    this.subscriptions.get(id)?.dispose();
    this.subscriptions.delete(id);
    this.layers = this.layers.filter((layer) => layer.id !== id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.layers = [];
    this.listeners.clear();
  }

  list(): readonly McpServerEntry[] {
    const seen = new Set<string>();
    const out: McpServerEntry[] = [];
    for (const layer of this.layers) {
      for (const entry of layer.view.list()) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        out.push(entry);
      }
    }
    return out;
  }

  get(name: string): McpServerEntry | undefined {
    return this.owner(name)?.view.get(name);
  }

  deferredOf(name: string): boolean {
    return this.owner(name)?.view.deferredOf(name) ?? false;
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.owner(name)?.view.resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.owner(name)?.view.getRemoteServerUrl(name);
  }

  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean> {
    const owner = this.owner(name);
    if (owner === undefined) return Promise.resolve(false);
    return owner.view.markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.requireOwner(name).view.reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.requireOwner(name).view.reconnectAndJoin(name);
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const all = Promise.all(
      this.layers.map((layer) => layer.view.waitForInitialLoad()),
    ).then(() => undefined);
    return signal === undefined ? all : abortable(all, signal);
  }

  initialLoadDurationMs(): number {
    if (this.layers.length === 0) return 0;
    return Math.max(...this.layers.map((layer) => layer.view.initialLoadDurationMs()));
  }

  onStatusChange(listener: McpStatusListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private owner(name: string): McpConnectionLayer | undefined {
    for (const layer of this.layers) {
      if (layer.view.get(name) !== undefined) return layer;
    }
    return this.layers[this.layers.length - 1];
  }

  private requireOwner(name: string): McpConnectionLayer {
    const owner = this.owner(name);
    if (owner !== undefined) return owner;
    throw new Error2(ErrorCodes.MCP_SERVER_NOT_FOUND, `Unknown MCP server: ${name}`);
  }
}
