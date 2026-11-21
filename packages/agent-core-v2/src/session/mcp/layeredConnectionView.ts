import { Event } from '#/_base/event';
import { abortable } from '#/_base/utils/abort';
import type {
  McpConnectionManager,
  McpConnectionView,
  McpServerEntry,
  McpStatusListener,
} from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient } from '#/mcpCore/types';

export interface McpViewLayer {
  readonly manager: McpConnectionManager;
  owns(name: string): boolean;
}

interface LayerStack {
  readonly upper: readonly McpViewLayer[];
  readonly bottom: McpViewLayer;
}

interface VisibleEntry {
  readonly manager: McpConnectionManager;
  readonly entry: McpServerEntry;
}

export class LayeredMcpConnectionView implements McpConnectionView {
  constructor(
    private readonly upper: () => readonly McpViewLayer[],
    private readonly bottom: McpViewLayer,
    private readonly onDidChangeLayers: Event<void> = Event.None as Event<void>,
  ) {}

  get oauthService(): McpOAuthService | undefined {
    return layersOf(this.stack()).find((layer) => layer.manager.oauthService !== undefined)
      ?.manager.oauthService;
  }

  list(): readonly McpServerEntry[] {
    return visibleEntries(this.stack()).map(({ entry }) => entry);
  }

  get(name: string): McpServerEntry | undefined {
    return this.owner(name).get(name);
  }

  deferredOf(name: string): boolean {
    return this.owner(name).deferredOf(name);
  }

  resolved(name: string): ReturnType<McpConnectionView['resolved']> {
    return this.owner(name).resolved(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return this.owner(name).getRemoteServerUrl(name);
  }

  markNeedsAuth(name: string, error: unknown, client?: MCPClient): Promise<boolean> {
    return this.owner(name).markNeedsAuth(name, error, client);
  }

  reconnect(name: string): Promise<void> {
    return this.owner(name).reconnect(name);
  }

  reconnectAndJoin(name: string): Promise<void> {
    return this.owner(name).reconnectAndJoin(name);
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const all = Promise.all(
      layersOf(this.stack()).map((layer) => layer.manager.waitForInitialLoad()),
    ).then(() => undefined);
    return signal === undefined ? all : abortable(all, signal);
  }

  initialLoadDurationMs(): number {
    return Math.max(
      ...layersOf(this.stack()).map((layer) => layer.manager.initialLoadDurationMs()),
    );
  }

  onStatusChange(listener: McpStatusListener): () => void {
    let stack = this.stack();
    const subscription = new StatusSubscription(listener, visibleEntries(stack));
    let detach = subscription.attach(stack);
    const relayering = this.onDidChangeLayers(() => {
      detach();
      stack = this.stack();
      detach = subscription.attach(stack);
      subscription.replay(visibleEntries(stack));
    });
    return () => {
      relayering.dispose();
      detach();
    };
  }

  private stack(): LayerStack {
    return { upper: this.upper(), bottom: this.bottom };
  }

  private owner(name: string): McpConnectionManager {
    return ownerOf(this.stack(), name).manager;
  }
}

function layersOf(stack: LayerStack): readonly McpViewLayer[] {
  return [...stack.upper, stack.bottom];
}

function ownerOf(stack: LayerStack, name: string): McpViewLayer {
  const layers = layersOf(stack);
  return (
    layers.find((layer) => layer.owns(name)) ??
    layers.find((layer) => isLive(layer.manager.get(name))) ??
    layers.find((layer) => layer.manager.get(name) !== undefined) ??
    stack.bottom
  );
}

function isLive(entry: McpServerEntry | undefined): boolean {
  return entry !== undefined && entry.status !== 'removed';
}

function visibleEntries(stack: LayerStack): VisibleEntry[] {
  return layersOf(stack)
    .toReversed()
    .flatMap((layer) =>
      layer.manager
        .list()
        .filter((entry) => ownerOf(stack, entry.name) === layer)
        .map((entry) => ({ manager: layer.manager, entry })),
    );
}

class StatusSubscription {
  private readonly delivered: Map<string, VisibleEntry>;

  constructor(
    private readonly listener: McpStatusListener,
    visible: readonly VisibleEntry[],
  ) {
    this.delivered = new Map(visible.map((item) => [item.entry.name, item]));
  }

  attach(stack: LayerStack): () => void {
    const unsubscribes = layersOf(stack).map((layer) =>
      layer.manager.onStatusChange((entry) => {
        const next = this.nextDelivery(stack, layer, entry);
        if (next !== undefined) this.deliver(next);
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  replay(visible: readonly VisibleEntry[]): void {
    const visibleNames = new Set(visible.map(({ entry }) => entry.name));
    for (const [name, { entry }] of this.delivered) {
      if (visibleNames.has(name)) continue;
      this.delivered.delete(name);
      this.listener({ name, transport: entry.transport, status: 'removed', toolCount: 0 });
    }
    for (const item of visible) {
      if (this.delivered.get(item.entry.name)?.manager !== item.manager) this.deliver(item);
    }
  }

  private nextDelivery(
    stack: LayerStack,
    layer: McpViewLayer,
    entry: McpServerEntry,
  ): VisibleEntry | undefined {
    const owner = ownerOf(stack, entry.name);
    if (owner === layer) return { manager: layer.manager, entry };
    if (this.delivered.get(entry.name)?.manager !== layer.manager) return undefined;
    const revealed = owner.manager.get(entry.name);
    if (revealed !== undefined && isLive(revealed)) return { manager: owner.manager, entry: revealed };
    return entry.status === 'removed' && !owner.owns(entry.name)
      ? { manager: layer.manager, entry }
      : undefined;
  }

  private deliver(item: VisibleEntry): void {
    this.delivered.set(item.entry.name, item);
    this.listener(item.entry);
  }
}
