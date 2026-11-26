import { ErrorCodes, Error2 } from '#/errors';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { abortable } from '#/_base/utils/abort';
import type {
  McpConnectionManager,
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient } from '#/mcpCore/types';

export interface McpConnectionLayer {
  readonly id: string;
  readonly priority: number;
  readonly view: McpConnectionView;
}

export class MergedMcpConnectionView implements McpConnectionView, IDisposable {
  private layers: readonly McpConnectionLayer[] = [];
  private effectiveEntries: Readonly<Record<string, McpServerConfig>> | undefined;
  private readonly subscriptions = new Map<string, IDisposable>();
  private readonly listeners = new Set<McpStatusListener>();
  private readonly published = new Map<string, string>();
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
        const effective = this.effectiveEntries?.[entry.name];
        if (this.effectiveEntries !== undefined && effective === undefined) return;
        if (effective?.enabled === false) {
          this.publishName(entry.name);
          return;
        }
        if (this.owner(entry.name)?.id !== layer.id) return;
        const projected = this.projectedEntry(entry.name);
        if (projected === undefined) return;
        this.published.set(entry.name, JSON.stringify(projected));
        for (const listener of Array.from(this.listeners)) listener(projected);
      }),
    );
    this.subscriptions.set(layer.id, subscription);
    this.reconcileNames(layer.view.list().map((entry) => entry.name));
    return toDisposable(() => this.removeLayer(layer.id));
  }

  removeLayer(id: string): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    this.subscriptions.get(id)?.dispose();
    this.subscriptions.delete(id);
    this.layers = this.layers.filter((candidate) => candidate.id !== id);
    if (layer !== undefined) {
      this.reconcileNames(layer.view.list().map((entry) => entry.name));
    }
  }

  setEffectiveEntries(entries: Readonly<Record<string, McpServerConfig>>): void {
    this.effectiveEntries = entries;
    this.reconcileNames(this.allKnownNames());
  }

  rescheduleRetries(): void {
    for (const layer of this.layers) {
      (layer.view as Partial<McpConnectionManager>).rescheduleRetries?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.layers = [];
    this.effectiveEntries = undefined;
    this.listeners.clear();
    this.published.clear();
  }

  list(): readonly McpServerEntry[] {
    if (this.effectiveEntries !== undefined) {
      return Object.keys(this.effectiveEntries).flatMap((name) => {
        const entry = this.projectedEntry(name);
        return entry === undefined ? [] : [entry];
      });
    }
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
    return this.projectedEntry(name);
  }

  deferredOf(name: string): boolean {
    const effective = this.effectiveEntries?.[name];
    if (effective?.deferred !== undefined) return effective.deferred;
    return this.owner(name)?.view.deferredOf(name) ?? false;
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    const effective = this.effectiveEntries?.[name];
    if (effective?.enabled === false) return undefined;
    const resolved = this.owner(name)?.view.resolved(name);
    if (resolved === undefined) return undefined;
    const deferred = this.deferredOf(name);
    if (effective === undefined) return resolved;
    const enabledNames = new Set(
      [...resolved.enabledNames].filter((toolName) => {
        if (effective.enabledTools !== undefined && !effective.enabledTools.includes(toolName)) return false;
        if (effective.disabledTools?.includes(toolName)) return false;
        return true;
      }),
    );
    return { ...resolved, enabledNames, deferred };
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
    if (this.effectiveEntries?.[name]?.enabled === false) {
      return Promise.reject(
        new Error2(ErrorCodes.MCP_SERVER_DISABLED, `MCP server is disabled: ${name}`),
      );
    }
    return this.requireOwner(name).view.reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.reconnect(name);
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

  private allKnownNames(): string[] {
    const names = new Set<string>(Object.keys(this.effectiveEntries ?? {}));
    for (const layer of this.layers) {
      for (const entry of layer.view.list()) names.add(entry.name);
    }
    for (const name of this.published.keys()) names.add(name);
    return [...names];
  }

  private reconcileNames(names: readonly string[]): void {
    for (const name of new Set(names)) {
      this.publishName(name);
    }
  }

  private publishName(name: string): void {
    if (this.disposed) return;
    const entry = this.projectedEntry(name);
    const signature = entry === undefined ? '' : JSON.stringify(entry);
    if (this.published.get(name) === signature) return;
    if (entry === undefined) {
      this.published.delete(name);
      return;
    }
    this.published.set(name, signature);
    for (const listener of Array.from(this.listeners)) listener(entry);
  }

  private projectedEntry(name: string): McpServerEntry | undefined {
    const effective = this.effectiveEntries?.[name];
    const layer = this.owner(name);
    if (this.effectiveEntries !== undefined && effective === undefined) return undefined;
    if (effective?.enabled === false) {
      return { name, transport: effective.transport, status: 'disabled', toolCount: 0 };
    }
    return layer?.view.get(name);
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
