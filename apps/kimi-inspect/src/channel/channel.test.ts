/**
 * Channel layer unit tests — `ProxyChannel` URL/envelope semantics, `makeProxy`
 * routing, and `WsChannel`'s ref-counted `listen`. The WS wire protocol itself
 * is covered by the kap-server contract and klient's e2e suites.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Event, IChannel } from './channel';
import { RPCError } from './errors';
import { makeProxy } from './proxy';
import { ProxyChannel } from './proxyChannel';
import { WsChannel } from './wsChannel';
import type { WsSocket } from './wsSocket';

const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'r1' });

function fakeFetch(envelope: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { json: async () => envelope };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function stubSocket() {
  const state = {
    listens: 0,
    disposed: 0,
    handler: undefined as ((data: unknown) => void) | undefined,
  };
  const raw = {
    call: vi.fn(async () => 'ws-ret'),
    listen: (
      _scope: string,
      _event: string,
      _ids: unknown,
      handler: (data: unknown) => void,
      _service?: string,
    ) => {
      state.listens += 1;
      state.handler = handler;
      return {
        dispose: () => {
          state.disposed += 1;
        },
      };
    },
  };
  return { raw, state, socket: raw as unknown as WsSocket };
}

describe('ProxyChannel.call', () => {
  it('POSTs the command to the service base URL; no body and no header without args/token', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ id: 's1' }));
    const channel = new ProxyChannel({
      baseUrl: 'http://h:1/api/v2/session/s%201/agent/main/agentRPCService',
      fetch: fetchImpl,
    });
    const result = await channel.call('getModel', []);
    expect(result).toEqual({ id: 's1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://h:1/api/v2/session/s%201/agent/main/agentRPCService/getModel');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('sends the complete argument array as the JSON body, plus the bearer token', async () => {
    const { calls, fetchImpl } = fakeFetch(ok(null));
    const channel = new ProxyChannel({
      baseUrl: 'http://h:2/api/v2/configService',
      token: 'tok',
      fetch: fetchImpl,
    });
    await channel.call('set', ['workspace', { theme: 'dark' }]);
    expect(calls[0]!.init?.body).toBe(JSON.stringify(['workspace', { theme: 'dark' }]));
    expect(calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
  });

  it('unwraps the envelope and throws RPCError on a non-zero code', async () => {
    const { fetchImpl } = fakeFetch({
      code: 40401,
      msg: 'session not found',
      data: null,
      request_id: 'r2',
      details: { id: 's9' },
    });
    const channel = new ProxyChannel({ baseUrl: 'http://h:3/api/v2/sessionIndex', fetch: fetchImpl });
    const err: unknown = await channel.call('get', ['s9']).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(RPCError);
    expect((err as RPCError).code).toBe(40401);
    expect((err as RPCError).message).toBe('session not found');
    expect((err as RPCError).details).toEqual({ id: 's9' });
  });
});

describe('makeProxy', () => {
  interface DemoService {
    read(id: string, n: number): Promise<string>;
    onDidChangeMetadata: Event<{ title: string }>;
  }

  it('routes methods to call and onXxx members to listen', async () => {
    const seen = { calls: [] as [string, unknown[]][], listens: [] as string[] };
    const channel: IChannel = {
      call: async <T,>(command: string, args?: unknown[]): Promise<T> => {
        seen.calls.push([command, args ?? []]);
        return 'ret' as T;
      },
      listen: <T,>(event: string): Event<T> => {
        seen.listens.push(event);
        return () => ({ dispose: () => {} });
      },
    };
    const svc = makeProxy<DemoService>(channel);
    await expect(svc.read('a', 1)).resolves.toBe('ret');
    expect(seen.calls).toEqual([['read', ['a', 1]]]);
    const d = svc.onDidChangeMetadata(() => {});
    d.dispose();
    expect(seen.listens).toEqual(['onDidChangeMetadata']);
  });
});

describe('WsChannel', () => {
  it('forwards calls over the socket with scope + service + ids', async () => {
    const { raw, socket } = stubSocket();
    const channel = new WsChannel({
      socket,
      scope: 'agent',
      service: 'agentRPCService',
      sessionId: 's1',
      agentId: 'main',
    });
    const result = await channel.call('getModel', [{}]);
    expect(result).toBe('ws-ret');
    expect(raw.call).toHaveBeenCalledWith('agent', 'agentRPCService', 'getModel', [{}], {
      sessionId: 's1',
      agentId: 'main',
    });
  });

  it('multiplexes local listeners onto one remote subscription', () => {
    const { state, socket } = stubSocket();
    const channel = new WsChannel({
      socket,
      scope: 'session',
      service: 'sessionMetadata',
      sessionId: 's1',
    });
    const onDidChange = channel.listen<unknown>('onDidChangeMetadata');
    const seen: unknown[] = [];
    const sub1 = onDidChange((e) => seen.push(['l1', e]));
    const sub2 = onDidChange((e) => seen.push(['l2', e]));
    expect(state.listens).toBe(1);
    state.handler!({ title: 't' });
    expect(seen).toEqual([
      ['l1', { title: 't' }],
      ['l2', { title: 't' }],
    ]);
    sub1.dispose();
    expect(state.disposed).toBe(0);
    sub2.dispose();
    expect(state.disposed).toBe(1);
  });
});

describe('ProxyChannel.listen', () => {
  it('throws without a WS binding', () => {
    const channel = new ProxyChannel({
      baseUrl: 'http://h:4/api/v2/configService',
      fetch: fakeFetch(ok(null)).fetchImpl,
    });
    expect(() => channel.listen('onDidChangeConfiguration')).toThrow(/events are not supported/);
  });

  it('delegates to one lazily-created WsChannel when a WS binding is provided', () => {
    const { state, socket } = stubSocket();
    const factory = vi.fn(() => new WsChannel({ socket, scope: 'core', service: 'configService' }));
    const channel = new ProxyChannel(
      { baseUrl: 'http://h:5/api/v2/configService', fetch: fakeFetch(ok(null)).fetchImpl },
      factory,
    );
    const sub = channel.listen<unknown>('onDidChangeConfiguration')(() => {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(state.listens).toBe(1);
    channel.listen('onDidSectionChange');
    expect(factory).toHaveBeenCalledTimes(1);
    sub.dispose();
    expect(state.disposed).toBe(1);
  });
});
