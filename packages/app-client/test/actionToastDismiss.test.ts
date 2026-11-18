// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import type { ToastEvent } from '../src/client/toast';

const clientApiMock: Record<string, unknown> = {};
const destroyed = vi.fn();

beforeEach(() => {
  destroyed.mockReset();
  setKimiClientDeps({
    api: () => clientApiMock as unknown as KimiWebApi,
    t: (key) => key,
    onSessionDestroyed: destroyed,
  });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
  clientApiMock.listSessions = vi.fn(async () => ({ items: [], total: 0 }));
  vi.stubGlobal('WebSocket', class {});
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetKimiClientDeps();
});

async function freshFacade() {
  vi.resetModules();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { dismissToastByKey, onToast } = await import('../src/client/toast');
  const events: ToastEvent[] = [];
  const off = onToast((event) => events.push(event));
  return { client: useKimiWebClient(), dismissToastByKey, events, off };
}

describe('action toast dismissal', () => {
  it('does not show batch undo feedback after its toast is dismissed', async () => {
    let finishRestore!: (value: {
      results: Array<{ id: string; ok: boolean }>;
      succeeded: number;
      failed: number;
    }) => void;
    clientApiMock.restoreSessions = vi.fn(() => new Promise((resolve) => { finishRestore = resolve; }));
    const { client, dismissToastByKey, events, off } = await freshFacade();

    client.showActionToast({
      kind: 'adminBatch',
      plan: { direction: 'archive', ids: ['s1'], succeeded: 1, failed: 0 },
    });
    const action = events.find((event) => event.type === 'show');
    const pending = action!.options!.actions![0]!.onClick({ dismiss: vi.fn() });
    dismissToastByKey(action!.key!);
    finishRestore({ results: [{ id: 's1', ok: true }], succeeded: 1, failed: 0 });
    await pending;
    off();

    expect(events.filter((event) => event.type === 'show')).toHaveLength(1);
  });

  it('does not show reopen undo feedback after its toast is dismissed', async () => {
    let finishArchive!: () => void;
    clientApiMock.archiveSession = vi.fn(() => new Promise<void>((resolve) => { finishArchive = resolve; }));
    const { client, dismissToastByKey, events, off } = await freshFacade();

    client.showActionToast({ kind: 'archive', id: 's1', reopen: true });
    const action = events.find((event) => event.type === 'show');
    const body = action!.options!.body as unknown as () => Array<{ props: { onClick: () => void } }>;
    body()[0]!.props.onClick();
    dismissToastByKey(action!.key!);
    finishArchive();
    await vi.waitFor(() => expect(destroyed).toHaveBeenCalledWith('s1'));
    await Promise.resolve();
    off();

    expect(events.filter((event) => event.type === 'show')).toHaveLength(1);
  });
});
