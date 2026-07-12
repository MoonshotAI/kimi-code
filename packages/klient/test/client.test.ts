import { afterEach, describe, expect, it, vi } from 'vitest';

import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { createDecorator } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import { Klient } from '../src/client.js';
import { HttpChannel } from '../src/httpChannel.js';
import { SessionIndexClient } from '../src/services/sessionIndex.js';

interface IAgentProfileLike {
  getModel(): Promise<unknown>;
}
const IAgentProfileLike = createDecorator<IAgentProfileLike>('agentProfileLike');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpChannel', () => {
  const fetchMock = vi.fn<typeof fetch>();
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('POSTs the method name to the service URL and unwraps envelope data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 0, msg: 'ok', data: { items: [] }, request_id: 'r1' }),
    );
    const channel = new HttpChannel({
      baseUrl: 'http://127.0.0.1:58627/api/v2/sessionIndex',
      fetch: fetchMock,
    });

    const data = await channel.call('list', [{ workspaceId: 'w1' }]);

    expect(data).toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url as string).toBe('http://127.0.0.1:58627/api/v2/sessionIndex/list');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify([{ workspaceId: 'w1' }]));
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('omits the body when no argument is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, msg: 'ok', data: 3, request_id: 'r2' }));
    const channel = new HttpChannel({ baseUrl: 'http://x/api/v2/sessionIndex', fetch: fetchMock });

    await channel.call('countActive');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
  });

  it('sends a bearer token when provided', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, msg: 'ok', data: null, request_id: 'r3' }));
    const channel = new HttpChannel({
      baseUrl: 'http://x/api/v2/sessionIndex',
      token: 't',
      fetch: fetchMock,
    });

    await channel.call('list');

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer t');
  });

  it('throws RPCError on a non-zero envelope code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 40001, msg: 'method not found', data: null, request_id: 'r4' }),
    );
    const channel = new HttpChannel({ baseUrl: 'http://x/api/v2/sessionIndex', fetch: fetchMock });

    await expect(channel.call('nope')).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
  });
});

describe('Klient scope routing', () => {
  it('routes core / session / agent scopes by decorator id', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      calls.push(input as string);
      return Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: null, request_id: 'r' }));
    });
    const client = new Klient({ url: 'http://127.0.0.1:58627', fetch: fetchMock });

    await client.core(ISessionIndex).list({});
    await client.session('s 1').service(ISessionMetadata).read();
    await client.session('s 1').agent('a 1').service(IAgentProfileLike).getModel();

    expect(calls).toEqual([
      'http://127.0.0.1:58627/api/v2/sessionIndex/list',
      'http://127.0.0.1:58627/api/v2/session/s%201/sessionMetadata/read',
      'http://127.0.0.1:58627/api/v2/session/s%201/agent/a%201/agentProfileLike/getModel',
    ]);
  });
});

describe('SessionIndexClient (explicit implementation)', () => {
  it('implements ISessionIndex over the channel', async () => {
    const page = {
      items: [{ id: 's1', workspaceId: 'w1', createdAt: 1, updatedAt: 2, archived: false }],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ code: 0, msg: 'ok', data: page, request_id: 'r' })),
      );
    const channel = new HttpChannel({ baseUrl: 'http://x/api/v2/sessionIndex', fetch: fetchMock });

    const index: ISessionIndex = new SessionIndexClient(channel);
    await expect(index.list({})).resolves.toEqual(page);
    await index.get('s1');
    await index.countActive('w1');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'http://x/api/v2/sessionIndex/list',
      'http://x/api/v2/sessionIndex/get',
      'http://x/api/v2/sessionIndex/countActive',
    ]);
  });
});
