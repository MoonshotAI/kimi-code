import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter, type Event } from '#/_base/event';
import { type ServiceIdentifier, createDecorator } from '#/_base/di';
import { InstantiationService } from '#/_base/di';
import type { IDisposable } from '#/_base/di';
import type { IScopeHandle, IServiceAccessor } from '#/scope/handle';
import { LifecycleScope } from '#/scope/lifecycle';
import {
  type IManagerEventBus,
  ScopeManager,
} from '#/scope/manager';

// ---------------------------------------------------------------------------
// Test doubles: FakeManager (parent-scope manager) + FakeChild (child scope).
// These validate the manager pattern; they are NOT real domain managers.
// ---------------------------------------------------------------------------

/** A per-child event source that lives inside the child scope. */
interface IFakeChildSource {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<{ value: number }>;
  setValue(value: number): void;
}
const IFakeChildSource = createDecorator<IFakeChildSource>('p14-fake-child-source');

/** A handle to the manager itself — used to prove a child cannot resolve it. */
interface IFakeManagerHandle {
  readonly _serviceBrand: undefined;
}
const IFakeManagerHandle = createDecorator<IFakeManagerHandle>('p14-fake-manager');

class FakeChildSource implements IFakeChildSource {
  readonly _serviceBrand: undefined;
  private readonly _onDidChange = new Emitter<{ value: number }>();
  readonly onDidChange = this._onDidChange.event;
  private _disposed = false;

  setValue(value: number): void {
    if (this._disposed) {
      throw new Error('FakeChildSource disposed');
    }
    this._onDidChange.fire({ value });
  }

  dispose(): void {
    this._disposed = true;
    this._onDidChange.dispose();
  }
}

interface FakeChildOptions {
  /** When set, `dispose()` rejects with this error (to exercise try/finally). */
  readonly disposeError?: Error;
}

/**
 * A child scope handle carrying a fake per-scope event source. Its `accessor`
 * resolves only `IFakeChildSource`; after `dispose()` it throws (data gone),
 * mirroring `ScopeHandle` semantics.
 */
class FakeChild implements IScopeHandle {
  readonly scope = LifecycleScope.Agent;
  readonly accessor: IServiceAccessor;
  readonly onWillDispose: Event<void>;
  readonly onDidDispose: Event<void>;

  private readonly _onWillDispose = new Emitter<void>();
  private readonly _onDidDispose = new Emitter<void>();
  private readonly source: FakeChildSource;
  private readonly disposeError?: Error;
  private _disposed = false;

  constructor(readonly id: string, options: FakeChildOptions = {}) {
    this.disposeError = options.disposeError;
    this.source = new FakeChildSource();
    this.onWillDispose = this._onWillDispose.event;
    this.onDidDispose = this._onDidDispose.event;
    this.accessor = {
      get: <T>(serviceId: ServiceIdentifier<T>): T => {
        if (this._disposed) {
          throw new Error(`FakeChild "${this.id}" already disposed`);
        }
        if (serviceId === IFakeChildSource) {
          return this.source as unknown as T;
        }
        throw new Error(`FakeChild "${this.id}" cannot resolve ${String(serviceId)}`);
      },
    };
  }

  /** Test hook: drive the child event source directly. */
  emit(value: number): void {
    this.source.setValue(value);
  }

  async dispose(_reason?: string): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._onWillDispose.fire();
    if (this.disposeError !== undefined) {
      this._disposed = true;
      throw this.disposeError;
    }
    this._disposed = true;
    this.source.dispose();
    this._onDidDispose.fire();
    this._onWillDispose.dispose();
    this._onDidDispose.dispose();
  }
}

/** Bus event shape published by the fake manager. */
interface FakeBusEvent {
  readonly kind: string;
  readonly childId: string;
  readonly reason?: string;
}

/** Recording event bus for assertions. */
class FakeBus implements IManagerEventBus<FakeBusEvent> {
  readonly events: FakeBusEvent[] = [];
  publish(event: FakeBusEvent): void {
    this.events.push(event);
  }
}

/**
 * Fake manager living in the parent scope. It tracks child handles, attaches to
 * each child's event source via `child.accessor.get(IFakeChildSource)`, and
 * re-emits collection-view events that add the child id.
 */
class FakeManager extends ScopeManager<FakeChild, FakeBusEvent> {
  private readonly _onDidChangeChildValue = new Emitter<{
    childId: string;
    value: number;
  }>();
  readonly onDidChangeChildValue = this._onDidChangeChildValue.event;

  /** Per-child subscription so teardown leaves no dangling listener. */
  private readonly childSubs = new Map<string, IDisposable>();

  constructor(bus: IManagerEventBus<FakeBusEvent>) {
    super(bus);
  }

  /** Build + attach a child, mirroring a real manager's create flow. */
  addChild(child: FakeChild): void {
    const source = child.accessor.get(IFakeChildSource);
    const sub = source.onDidChange(({ value }) => {
      // Re-emit as a collection-view event, adding the child id.
      this._onDidChangeChildValue.fire({ childId: child.id, value });
      this.publish({ kind: 'child.value-changed', childId: child.id });
    });
    this.childSubs.set(child.id, sub);
    this.trackChild(child);
  }

  protected buildDisposeEvent(childId: string, reason?: string): FakeBusEvent {
    return { kind: 'child.disposed', childId, reason };
  }

  override async disposeChild(childId: string, reason?: string): Promise<void> {
    try {
      await super.disposeChild(childId, reason);
    } finally {
      const sub = this.childSubs.get(childId);
      if (sub !== undefined) {
        sub.dispose();
        this.childSubs.delete(childId);
      }
    }
  }

  override dispose(): void {
    for (const sub of this.childSubs.values()) {
      sub.dispose();
    }
    this.childSubs.clear();
    this._onDidChangeChildValue.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): { manager: FakeManager; bus: FakeBus; parent: InstantiationService } {
  const parent = new InstantiationService();
  const bus = new FakeBus();
  // The manager is instantiated by the parent scope's container — it lives in
  // the parent scope, while the children it tracks are separate child scopes.
  const manager = parent.createInstance(FakeManager, bus);
  return { manager, bus, parent };
}

describe('ScopeManager (manager service pattern)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lives in the parent scope and tracks children in Map<childId, IScopeHandle>', () => {
    const { manager, parent } = makeManager();
    const a = new FakeChild('a1');
    const b = new FakeChild('a2');

    manager.addChild(a);
    manager.addChild(b);

    // The manager is a distinct object constructed by the parent container.
    expect(manager).toBeInstanceOf(FakeManager);
    expect(parent).toBeInstanceOf(InstantiationService);

    // Tracks children in the single allowed map keyed by child id.
    expect(manager.children.size).toBe(2);
    expect(manager.hasChild('a1')).toBe(true);
    expect(manager.hasChild('a2')).toBe(true);
    expect(manager.children.get('a1')).toBe(a);
    expect(manager.children.get('a2')).toBe(b);

    manager.dispose();
  });

  it('attaches via child.accessor.get and re-emits collection-view events with child id', () => {
    const { manager, bus } = makeManager();
    const child = new FakeChild('a1');
    manager.addChild(child);

    const fired: { childId: string; value: number }[] = [];
    manager.onDidChangeChildValue((e) => fired.push(e));

    child.emit(7);
    child.emit(42);

    // Collection-view events carry the originating child id.
    expect(fired).toEqual([
      { childId: 'a1', value: 7 },
      { childId: 'a1', value: 42 },
    ]);
    // And are published to the bus with the child id.
    expect(bus.events).toEqual([
      { kind: 'child.value-changed', childId: 'a1' },
      { kind: 'child.value-changed', childId: 'a1' },
    ]);

    manager.dispose();
  });

  it('disposeChild fires onDidChildDispose + eventBus.publish in try/finally (success path)', async () => {
    const { manager, bus } = makeManager();
    const child = new FakeChild('a1');
    manager.addChild(child);

    const disposed: { childId: string; reason?: string }[] = [];
    manager.onDidChildDispose((e) => disposed.push(e));

    await manager.disposeChild('a1', 'done');

    // Child dropped from the tracking map.
    expect(manager.hasChild('a1')).toBe(false);
    expect(manager.children.size).toBe(0);
    // onDidChildDispose fired with the child id + reason.
    expect(disposed).toEqual([{ childId: 'a1', reason: 'done' }]);
    // Bus event published in the finally block.
    expect(bus.events).toEqual([
      { kind: 'child.disposed', childId: 'a1', reason: 'done' },
    ]);

    manager.dispose();
  });

  it('disposeChild still fires onDidChildDispose + publish when child.dispose throws', async () => {
    const { manager, bus } = makeManager();
    const boom = new Error('dispose failed');
    const child = new FakeChild('a1', { disposeError: boom });
    manager.addChild(child);

    const disposed: string[] = [];
    manager.onDidChildDispose((e) => disposed.push(e.childId));

    await expect(manager.disposeChild('a1', 'abort')).rejects.toThrow(boom);

    // Finally ran despite the rejection: child dropped, event fired, bus published.
    expect(manager.hasChild('a1')).toBe(false);
    expect(disposed).toEqual(['a1']);
    expect(bus.events).toEqual([
      { kind: 'child.disposed', childId: 'a1', reason: 'abort' },
    ]);

    manager.dispose();
  });

  it('does not expose manager write methods to children (no reverse-call)', () => {
    const { manager } = makeManager();
    const child = new FakeChild('a1');
    manager.addChild(child);

    // The child handle only carries IScopeHandle surface — none of the
    // manager's write methods are reachable from it.
    expect('disposeChild' in child).toBe(false);
    expect('addChild' in child).toBe(false);
    expect('trackChild' in child).toBe(false);

    // A child cannot resolve the manager through its own accessor, so there is
    // no reverse-call channel into the manager.
    expect(() => child.accessor.get(IFakeManagerHandle)).toThrow();

    manager.dispose();
  });

  it('onDidChildDispose listeners update parent state only; child services are gone', async () => {
    const { manager } = makeManager();
    const child = new FakeChild('a1');
    manager.addChild(child);

    const parentRemovedIds: string[] = [];
    let childReadAfterDispose: 'ok' | 'threw' = 'ok';
    manager.onDidChildDispose(({ childId }) => {
      // Parent updates only its own state.
      parentRemovedIds.push(childId);
      // Touching the child's services is forbidden — the data is already gone.
      try {
        child.accessor.get(IFakeChildSource);
      } catch {
        childReadAfterDispose = 'threw';
      }
    });

    await manager.disposeChild('a1');

    expect(parentRemovedIds).toEqual(['a1']);
    expect(childReadAfterDispose).toBe('threw');

    manager.dispose();
  });

  it('disposeChild is a no-op for an unknown childId', async () => {
    const { manager, bus } = makeManager();
    const disposed: string[] = [];
    manager.onDidChildDispose((e) => disposed.push(e.childId));

    await expect(manager.disposeChild('missing')).resolves.toBeUndefined();

    expect(disposed).toEqual([]);
    expect(bus.events).toEqual([]);

    manager.dispose();
  });
});
