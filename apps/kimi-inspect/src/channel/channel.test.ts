/**
 * Channel layer unit tests — `ProxyChannel` URL/envelope semantics,
 * `makeProxy` routing, the HTTP-only `listen` failure, and the debug-surface
 * probe (`/api/v1/debug` is the only RPC surface; there is no v2 fallback).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Event, IChannel } from './channel';
import { probeDebugSurface } from './channels';
import { RPCError } from './errors';
import { makeProxy } from './proxy';
import { ProxyChannel } from './proxyChannel';

const ok = (data: unknown) => ({ code: 0, msg: 'success', data, request_id: 'r1' });

function fakeFetch(envelope: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { json: async () => envelope };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProxyChannel.call', () => {
  it('POSTs the command to the service base URL; no body and no header without args/token', async () => {
    const { calls, fetchImpl } = fakeFetch(ok({ id: 's1' }));
    const channel = new ProxyChannel({
      baseUrl: 'http://h:1/api/v1/debug/session/s%201/agent/main/agentRPCService',
      fetch: fetchImpl,
    });
    const result = await channel.call('getModel', []);
    expect(result).toEqual({ id: 's1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'http://h:1/api/v1/debug/session/s%201/agent/main/agentRPCService/getModel',
    );
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('sends the complete argument array as the JSON body, plus the bearer token', async () => {
    const { calls, fetchImpl } = fakeFetch(ok(null));
    const channel = new ProxyChannel({
      baseUrl: 'http://h:2/api/v1/debug/configService',
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
    const channel = new ProxyChannel({
      baseUrl: 'http://h:3/api/v1/debug/sessionIndex',
      fetch: fetchImpl,
    });
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

describe('ProxyChannel.listen', () => {
  it('throws: the debug surface is HTTP-only, there is no event transport', () => {
    const channel = new ProxyChannel({
      baseUrl: 'http://h:4/api/v1/debug/configService',
      fetch: fakeFetch(ok(null)).fetchImpl,
    });
    expect(() => channel.listen('onDidChangeConfiguration')).toThrow(/events are not supported/);
  });
});

describe('probeDebugSurface', () => {
  function stubProbeFetch(impl: (url: string, init?: RequestInit) => unknown) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return impl(String(url), init);
    });
    return calls;
  }

  it('resolves when /api/v1/debug/channels answers a zero-code envelope (with bearer header)', async () => {
    const calls = stubProbeFetch(() => ({ ok: true, json: async () => ({ code: 0 }) }));
    await expect(
      probeDebugSurface({ baseUrl: 'http://h:5/', token: 'tok' }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('http://h:5/api/v1/debug/channels');
    expect(calls[0]!.init?.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('throws a --debug-endpoints hint when the surface is not mounted (HTTP 404)', async () => {
    stubProbeFetch(() => ({ ok: false, status: 404 }));
    await expect(probeDebugSurface({ baseUrl: 'http://h:6' })).rejects.toThrow(
      /--debug-endpoints/,
    );
  });

  it('throws an unreachable-server error when fetch itself fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(probeDebugSurface({ baseUrl: 'http://h:7' })).rejects.toThrow(/cannot reach/);
  });

  it('throws a token hint when the envelope carries a non-zero code', async () => {
    stubProbeFetch(() => ({
      ok: true,
      json: async () => ({ code: 40101, msg: 'unauthorized' }),
    }));
    await expect(probeDebugSurface({ baseUrl: 'http://h:8' })).rejects.toThrow(/bearer token/);
  });
});
