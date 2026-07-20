import { describe, expect, it } from 'vitest';

import { ISessionInteractionService, type IDisposable } from '@moonshot-ai/agent-core-v2';

import { resolveEventSource } from '../src/transport/ws/eventMap';

interface ManualEvent<T> {
  readonly event: (listener: (e: T) => void) => IDisposable;
  readonly fire: (e: T) => void;
}

function manualEvent<T>(): ManualEvent<T> {
  const listeners = new Set<(e: T) => void>();
  return {
    event: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (e) => {
      for (const l of listeners) l(e);
    },
  };
}

describe('session `interactions` event source', () => {
  it('forwards the current pending set whenever onDidChange fires', () => {
    const { event, fire } = manualEvent<void>();
    let pending: readonly unknown[] = [];
    const interaction = {
      onDidChangePending: event,
      listPending: () => pending,
    };
    const scope = {
      accessor: {
        get: (id: unknown) => (id === ISessionInteractionService ? interaction : undefined),
      },
    };

    const source = resolveEventSource('session', 'interactions');
    expect(source).toBeDefined();

    const seen: unknown[] = [];
    const disposable = source!.subscribe(scope as never, (data) => seen.push(data));

    pending = [{ id: 'a', kind: 'approval' }];
    fire();
    pending = [];
    fire();

    expect(seen).toEqual([[{ id: 'a', kind: 'approval' }], []]);

    disposable.dispose();
    fire();
    expect(seen).toHaveLength(2);
  });

  it('returns undefined for an unknown session event', () => {
    expect(resolveEventSource('session', 'nope')).toBeUndefined();
  });
});

describe('session `interactions:resolved` event source', () => {
  it('forwards each resolution to the listener', () => {
    const { event, fire } = manualEvent<{ id: string; response: unknown }>();
    const interaction = {
      onDidResolve: event,
    };
    const scope = {
      accessor: {
        get: (id: unknown) => (id === ISessionInteractionService ? interaction : undefined),
      },
    };

    const source = resolveEventSource('session', 'interactions:resolved');
    expect(source).toBeDefined();

    const seen: unknown[] = [];
    const disposable = source!.subscribe(scope as never, (data) => seen.push(data));

    fire({ id: 'e1', response: { decision: 'approved' } });
    fire({ id: 'e2', response: 'kimi' });

    expect(seen).toEqual([
      { id: 'e1', response: { decision: 'approved' } },
      { id: 'e2', response: 'kimi' },
    ]);

    disposable.dispose();
    fire({ id: 'e3', response: null });
    expect(seen).toHaveLength(2);
  });
});
