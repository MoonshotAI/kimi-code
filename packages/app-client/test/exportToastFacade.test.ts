// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import type { ToastEvent } from '../src/client/toast';

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
  vi.stubGlobal('WebSocket', class {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL = vi.fn(() => 'blob:export');
    static revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKimiClientDeps();
});

async function freshFacade() {
  vi.resetModules();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { dismissToastByKey, onToast, toast } = await import('../src/client/toast');
  const events: ToastEvent[] = [];
  const off = onToast((event) => events.push(event));
  return { client: useKimiWebClient(), dismissToastByKey, events, off, toast };
}

describe('exportSessionWithToast', () => {
  it('shows completion when export finishes before the running delay', async () => {
    clientApiMock.exportSession = vi.fn(async () => ({ blob: new Blob(['zip']), fileName: 's1.zip' }));
    const { client, events, off } = await freshFacade();
    vi.useFakeTimers();

    await client.exportSessionWithToast('s1');
    await vi.advanceTimersByTimeAsync(400);
    off();

    const shown = events.filter((event) => event.type === 'show');
    expect(shown.map((event) => event.options?.title)).toEqual(['commands.export.done']);
  });

  it('replaces a visible running toast when a slow export completes', async () => {
    let resolveExport!: (value: { blob: Blob; fileName: string }) => void;
    clientApiMock.exportSession = vi.fn(() => new Promise((resolve) => { resolveExport = resolve; }));
    const { client, events, off } = await freshFacade();
    vi.useFakeTimers();

    const pending = client.exportSessionWithToast('s1');
    await vi.advanceTimersByTimeAsync(400);
    resolveExport({ blob: new Blob(['zip']), fileName: 's1.zip' });
    await pending;
    off();

    const shown = events.filter((event) => event.type === 'show');
    expect(shown.map((event) => event.options?.title)).toEqual([
      'commands.export.started',
      'commands.export.done',
    ]);
  });

  it('does not replace newer direct toast feedback with delayed export states', async () => {
    let resolveExport!: (value: { blob: Blob; fileName: string }) => void;
    clientApiMock.exportSession = vi.fn(() => new Promise((resolve) => { resolveExport = resolve; }));
    const { client, events, off, toast } = await freshFacade();
    vi.useFakeTimers();

    const pending = client.exportSessionWithToast('s1');
    toast({ layout: 'bar', mode: 'replace', title: 'conversation.undone' });
    await vi.advanceTimersByTimeAsync(400);
    resolveExport({ blob: new Blob(['zip']), fileName: 's1.zip' });
    await pending;
    off();

    const shown = events.filter((event) => event.type === 'show');
    expect(shown.map((event) => event.options?.title)).toEqual(['conversation.undone']);
  });

  it('does not show completion after the running toast is dismissed', async () => {
    let resolveExport!: (value: { blob: Blob; fileName: string }) => void;
    clientApiMock.exportSession = vi.fn(() => new Promise((resolve) => { resolveExport = resolve; }));
    const { client, dismissToastByKey, events, off } = await freshFacade();
    vi.useFakeTimers();

    const pending = client.exportSessionWithToast('s1');
    await vi.advanceTimersByTimeAsync(400);
    const running = events.find((event) => event.type === 'show' && event.options?.running);
    dismissToastByKey(running!.key!);
    resolveExport({ blob: new Blob(['zip']), fileName: 's1.zip' });
    await pending;
    off();

    const shown = events.filter((event) => event.type === 'show');
    expect(shown.map((event) => event.options?.title)).toEqual(['commands.export.started']);
  });

  it('dismisses the matching running toast when a slow export fails', async () => {
    let rejectExport!: (error: Error) => void;
    clientApiMock.exportSession = vi.fn(() => new Promise((_, reject) => { rejectExport = reject; }));
    const { client, events, off } = await freshFacade();
    vi.useFakeTimers();

    const pending = client.exportSessionWithToast('s1');
    await vi.advanceTimersByTimeAsync(400);
    rejectExport(new Error('export failed'));
    await pending;
    off();

    const running = events.find((event) => event.type === 'show' && event.options?.running);
    expect(events).toContainEqual({ type: 'dismiss', key: running?.key });
  });
});
