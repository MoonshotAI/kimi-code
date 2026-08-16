/**
 * Channel layer unit tests — `ProxyChannel` URL/envelope semantics,
 * `makeProxy` routing, the HTTP-only `listen` failure, and the debug-surface
 * probe (`/api/v1/debug` is the only RPC surface; there is no v2 fallback).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Event, IChannel } from './channel';
import { probeDebugSurface } from './channels';
import { createInspectClient } from './client';
import { RPCError } from './errors';
import {
  fetchAgentRuntimeBinding,
  fetchSessionWorkspaceAssociation,
  fetchWorkspaceSnapshot,
} from '../snapshots/api';
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
      baseUrl: 'http://h:1/api/v1/debug/session/s%201/agent/main/agentLoopService',
      fetch: fetchImpl,
    });
    const result = await channel.call('getModel', []);
    expect(result).toEqual({ id: 's1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'http://h:1/api/v1/debug/session/s%201/agent/main/agentLoopService/getModel',
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
      call: async <T>(command: string, args?: unknown[]): Promise<T> => {
        seen.calls.push([command, args ?? []]);
        return 'ret' as T;
      },
      listen: <T>(event: string): Event<T> => {
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

describe('business snapshots', () => {
  it('uses explicit workspace, session association, and agent binding routes', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const value = String(url);
      calls.push(value);
      if (value.endsWith('/workspace/w%201/snapshot')) {
        return { json: async () => ok({ metadata: { id: 'w 1' } }) };
      }
      if (value.endsWith('/session/s%201/association')) {
        return { json: async () => ok({ sessionId: 's 1', workspaceId: 'w 1', cwd: '/work' }) };
      }
      return {
        json: async () => ok({
          binding: { workspaceId: 'w 1', runtimeId: 'remote' },
          available: true,
          runtime: { runtimeId: 'remote', generation: 'g2', status: 'ready', capabilities: ['process'] },
        }),
      };
    });
    const client = createInspectClient({ url: 'http://h:9', token: 'tok' });

    await expect(fetchWorkspaceSnapshot(client, 'w 1')).resolves.toMatchObject({ metadata: { id: 'w 1' } });
    await expect(fetchSessionWorkspaceAssociation(client, 's 1')).resolves.toMatchObject({ workspaceId: 'w 1' });
    await expect(fetchAgentRuntimeBinding(client, 's 1', 'main')).resolves.toMatchObject({
      binding: { runtimeId: 'remote' },
      runtime: { generation: 'g2' },
    });
    expect(calls).toEqual([
      'http://h:9/api/v1/debug/workspace/w%201/snapshot',
      'http://h:9/api/v1/debug/session/s%201/association',
      'http://h:9/api/v1/debug/session/s%201/agent/main/runtime-binding',
    ]);
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
    await expect(probeDebugSurface({ baseUrl: 'http://h:6' })).rejects.toThrow(/--debug-endpoints/);
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
