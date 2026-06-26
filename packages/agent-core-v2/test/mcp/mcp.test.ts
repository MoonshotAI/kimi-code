import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/eventBus';
import type { McpConnectionManager, McpServerEntry } from '#/mcp/connection-manager';
import { IMcpService, McpService } from '#/mcp';
import { IToolRegistry } from '#/toolRegistry';

/**
 * Minimal stand-in for {@link McpConnectionManager}. `McpService` delegates
 * `list`, `onStatusChange`, `resolved`, etc. to its manager, so the fake only
 * needs to model server entries and status transitions. `connect`/`disconnect`
 * are test drivers that mirror the real manager's transitions (connected on
 * connect, disabled + removed on disconnect).
 */
class FakeMcpManager {
  private readonly entries = new Map<string, McpServerEntry>();
  private readonly listeners = new Set<(entry: McpServerEntry) => void>();
  readonly oauthService = undefined;

  list(): readonly McpServerEntry[] {
    return [...this.entries.values()];
  }

  resolved(): undefined {
    return undefined;
  }

  getRemoteServerUrl(): undefined {
    return undefined;
  }

  async reconnect(): Promise<void> {}

  async waitForInitialLoad(): Promise<void> {}

  initialLoadDurationMs(): number {
    return 0;
  }

  onStatusChange(listener: (entry: McpServerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(name: string): void {
    const entry: McpServerEntry = { name, transport: 'stdio', status: 'connected', toolCount: 0 };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  disconnect(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'disabled' };
    this.emit(entry);
    this.entries.delete(name);
  }

  private emit(entry: McpServerEntry): void {
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}

describe('McpService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IEventBus, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(IToolRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
      resolve: () => undefined,
    });
  });
  afterEach(() => disposables.dispose());

  it('delegates list / status events to the connection manager', () => {
    const manager = new FakeMcpManager();
    // McpService takes its manager through the static `options` constructor
    // arg, which the IMcpService binding cannot supply (it only injects
    // @IService deps), so the configured instance is built via createInstance.
    // The two trailing placeholders are filled by the @IService-decorated
    // deps (IToolRegistry / IEventBus) at runtime; they mirror the
    // `undefined as never` pattern used elsewhere for leading static args.
    const svc = ix.createInstance(
      McpService,
      { manager: manager as unknown as McpConnectionManager },
      undefined as never,
      undefined as never,
    );
    disposables.add(svc);

    const statuses: string[] = [];
    svc.onStatusChange((e) => statuses.push(`${e.name}:${e.status}`));

    manager.connect('s1');
    manager.connect('s2');
    expect([...svc.list().map((e) => e.name)].sort()).toEqual(['s1', 's2']);

    manager.disconnect('s1');
    expect(svc.list().map((e) => e.name)).toEqual(['s2']);

    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disabled']);
  });

  it('resolves through the IMcpService binding with no manager', () => {
    ix.set(IMcpService, new SyncDescriptor(McpService));
    const svc = ix.get(IMcpService);
    expect(svc.list()).toEqual([]);
  });
});
