import { describe, expect, it, vi } from 'vitest';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records calls, replays scripted results, and captures listen subscriptions. */
class FakeChannel implements KlientChannel {
  readonly calls: Array<{ scope: ScopeRef; service: string; method: string; args: unknown[] }> = [];
  readonly subscriptions: Array<{ source: EventSourceRef; dispose: ReturnType<typeof vi.fn> }> =
    [];
  result: unknown;
  /** Keyed `${service}.${method}` result overrides. */
  readonly results = new Map<string, unknown>();
  private readonly handlers = new Map<number, (data: unknown) => void>();
  private nextSub = 0;

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ scope, service, method, args });
    const key = `${service}.${method}`;
    return Promise.resolve(this.results.has(key) ? this.results.get(key) : this.result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_scope: ScopeRef, _service: string, _method: string, _args: unknown[]): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised in facade tests
  }

  listen(_scope: ScopeRef, source: EventSourceRef, handler: (data: unknown) => void): IDisposable {
    const id = this.nextSub;
    this.nextSub += 1;
    this.handlers.set(id, handler);
    const dispose = vi.fn(() => {
      this.handlers.delete(id);
    });
    this.subscriptions.push({ source, dispose });
    return { dispose };
  }

  /** Push a raw payload into the Nth subscription (0-based). */
  emit(index: number, data: unknown): void {
    this.handlers.get(index)?.(data);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SUMMARY = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

describe('facade routing', () => {
  it('reshapes single-object params into positional wire args', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = { id: 'w1', root: '/x', name: 'n', createdAt: 1, lastOpenedAt: 2 };
    await klient.global.workspaces.createOrTouch({ root: '/x', name: 'n' });
    expect(channel.calls[0]).toMatchObject({
      service: 'workspaceService',
      method: 'createOrTouch',
      args: ['/x', 'n'],
    });

    channel.result = undefined; // void output
    await klient.global.plugins.setMcpServerEnabled({ id: 'p', server: 's', enabled: true });
    expect(channel.calls[1]).toMatchObject({
      service: 'pluginService',
      method: 'setPluginMcpServerEnabled',
      args: [{ id: 'p', server: 's', enabled: true }],
    });

    channel.results.set('oauthService.status', { loggedIn: false });
    await klient.global.auth.status();
    expect(channel.calls[2]).toMatchObject({
      service: 'oauthService',
      method: 'status',
      args: [undefined],
    });
  });

  it('env() fans out property reads and merges them', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    const env = await klient.global.env();
    expect(env.platform).toBe('v');
    expect(env.logsDir).toBe('v');
    expect(channel.calls).toHaveLength(12);
    expect(channel.calls.every((call) => call.service === 'bootstrapService')).toBe(true);
  });

  it('env() resolves once and serves repeats from the cache', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    await klient.global.env();
    expect(channel.calls).toHaveLength(12);

    const again = await klient.global.env();
    expect(again.platform).toBe('v');
    expect(channel.calls).toHaveLength(12);
  });
});

describe('contract validation', () => {
  it('rejects invalid input before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });

  it('rejects drifted output payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = { id: 's1' }; // missing required SessionSummary fields
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('passes valid payloads through and returns parsed output', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SUMMARY;
    await expect(klient.global.sessions.get('s1')).resolves.toEqual(SUMMARY);
  });

  it('validate:false skips both directions', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.result = { anything: true };
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).resolves.toEqual({ anything: true });
  });
});

describe('event hub', () => {
  it('maps public names to emitter sources and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });

    klient.events.on('kosong.providers.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    channel.emit(0, { added: ['p1'], removed: [], changed: [] });
    channel.emit(0, { added: 'not-an-array' });
    await tick();
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });

  it('shares one bus subscription across bus-derived events and filters by type', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const archived: unknown[] = [];
    const catalog: unknown[] = [];

    const subA = klient.events.on('session.archived', (event) => archived.push(event));
    const subB = klient.events.on('kosong.changed', (event) => catalog.push(event));
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    channel.emit(0, { type: 'event.session.archived', payload: { sessionId: 's1' } });
    channel.emit(0, { type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    channel.emit(0, { type: 'unrelated.type', payload: {} });
    await tick();
    expect(archived).toEqual([{ sessionId: 's1' }]);
    expect(catalog).toEqual([{ changed: [], unchanged: [], failed: [] }]);

    subA.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    subB.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the emitter subscription when the last listener detaches', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const a = klient.events.on('config.changed', () => undefined);
    const b = klient.events.on('config.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    a.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    b.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});
