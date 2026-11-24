
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonApiError, DaemonNetworkError, isDaemonTimeoutError } from '../src/api/errors';
import { HostRouter } from '../src/api/hostRouting';
import type { RestRequestInfo } from '../src/contracts';
import type { AppEvent, AppSessionRatingReport, KimiEventConnection, ReadRequestOptions } from '../src/api/types';

const tracedRequests: RestRequestInfo[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createApi(origin = 'http://daemon.test'): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    origin,
    identity: {
      clientId: 'web_test',
      clientName: 'test',
      clientVersion: '0.0.0',
      clientUiMode: 'test',
    },
    tracer: {
      restRequest: (info) => tracedRequests.push(info),
    },
  });
}

it('submits feedback and attachments without tracing text or local filenames', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(envelope({ feedback_id: 42 }))
    .mockResolvedValueOnce(envelope({ feedback_id: 42 }))
    .mockResolvedValueOnce(envelope({ upload_id: 9 }))
    .mockResolvedValueOnce(envelope({ upload_id: 10 }));
  vi.stubGlobal('fetch', request);
  const firstTrace = tracedRequests.length;
  try {
    const api = createApi();
    await expect(api.createFeedback({ kind: 'global', source: 'command', category: 'bug', content: 'Private description' })).resolves.toEqual({ feedback_id: 42 });
    await expect(api.updateFeedback(42, { kind: 'details', reasons: ['other'], content: 'Private details' })).resolves.toEqual({ feedback_id: 42 });
    await expect(api.uploadFeedbackAttachment(42, { kind: 'media', file: new Blob(['file']), fileName: 'private.png' })).resolves.toEqual({ upload_id: 9 });

    await expect(api.uploadFeedbackSession(42, 'example-session')).resolves.toEqual({ upload_id: 10 });

    expect(request.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['http://daemon.test/api/v1/feedback', 'POST'],
      ['http://daemon.test/api/v1/feedback/42', 'PATCH'],
      ['http://daemon.test/api/v1/feedback/42/attachments?kind=media', 'POST'],
      ['http://daemon.test/api/v1/feedback/42/attachments/session', 'POST'],
    ]);
    expect(JSON.parse(request.mock.calls[0]?.[1].body).content).toBe('Private description');
    expect(request.mock.calls[2]?.[1].body.get('file').name).toBe('private.png');
    expect(request.mock.calls.map(([, options]) => options.redirect)).toEqual(['error', 'error', 'error', 'error']);
    expect(tracedRequests.slice(firstTrace).map((entry) => entry.body)).toEqual([undefined, undefined, undefined, undefined]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps feedback content out of tracing when the host returns an invalid response', async () => {
  const restFailure = vi.fn();
  const restResponse = vi.fn();
  const api = new DaemonKimiWebApi({ origin: 'http://daemon.test', tracer: { restFailure, restResponse } });
  const content = 'Example feedback';
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(content))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40001, msg: content, details: content }))));
  try {
    await expect(api.createFeedback({ kind: 'global', source: 'sidebar', category: 'bug', content })).rejects.toBeInstanceOf(DaemonNetworkError);
    const [failure] = restFailure.mock.calls[0]!;
    expect(failure.bodyPreview).toBeUndefined();
    expect(String(failure.error)).not.toContain(content);
    await expect(api.uploadFeedbackAttachment(7, { kind: 'media', file: new Blob([content]), fileName: 'example.png' })).rejects.toBeInstanceOf(DaemonApiError);
    expect(JSON.stringify(restResponse.mock.calls)).not.toContain(content);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('opens daemon authentication only for server credentials and not Kimi login errors', async () => {
  const markAuthRequired = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify({
    code: Number(JSON.parse(init.body).content), msg: 'Authentication required', data: null,
  }), { status: 401 })));
  try {
    const api = new DaemonKimiWebApi({ origin: 'http://daemon.test', credentialStore: { markAuthRequired, getToken: () => undefined } });
    for (const code of [40111, 40112, 40101]) {
      await expect(api.createFeedback({ kind: 'global', source: 'sidebar', category: 'other', content: String(code) })).rejects.toMatchObject({ code });
    }
    expect(markAuthRequired).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('DaemonKimiWebApi lists across hosts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function hostAwareApi(includeHosts: boolean): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      includeHosts,
    });
  }

  it('asks this machine for every host and keeps the host the server named', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(envelope({
        items: [{ id: 'wm_1', root: '/srv/app', name: 'app', kind: 'managed', additional_dirs: [], session_count: 0, host_id: 'dev' }],
      }))
      .mockResolvedValueOnce(envelope({
        items: [{ id: 's1', host_id: 'dev' }],
        has_more: false,
        next_page_token: null,
        total: 1,
      }));
    const api = hostAwareApi(true);

    const workspaces = await api.listWorkspaces();
    const page = await api.listSessionIds({ pageSize: 10 });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspaces?hosts=include');
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('http://daemon.test/api/v1/sessions?page_size=10&fields=id%2Carchived&hosts=include');
    expect(workspaces[0]?.hostId).toBe('dev');
    expect(page).toMatchObject({ items: [{ id: 's1', host_id: 'dev' }] });
  });

  it('lists every session of every host at once and finds a session on its host', async () => {
    const wire = (id: string, hostId?: string) => ({
      id,
      title: id,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      activity: 'idle',
      archived: false,
      cwd: '/srv/app',
      ...(hostId === undefined ? {} : { host_id: hostId }),
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(envelope({ items: [wire('s1', 'dev'), wire('s2')], has_more: false, unavailable_hosts: ['off'] }))
      .mockResolvedValueOnce(envelope({ items: [], has_more: false }))
      .mockResolvedValueOnce(envelope(wire('s1', 'dev')));
    const api = hostAwareApi(true);

    const page = await api.listSessions({ hasPrompt: true });
    await api.listSessions({ workspaceId: 'wm_1', pageSize: 20 });
    const found = await api.findSession('s1');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/sessions?has_prompt=true&hosts=include');
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('http://daemon.test/api/v1/sessions?page_size=20&workspace_id=wm_1&hosts=include');
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe('http://daemon.test/api/v1/sessions/s1?hosts=include');
    expect(page.items.map((session) => [session.id, session.hostId])).toEqual([['s1', 'dev'], ['s2', undefined]]);
    expect(page.unavailableHosts).toEqual(['off']);
    expect(found.hostId).toBe('dev');
  });

  it('searches only this machine when a session listing is local-only', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [], has_more: false }));

    await hostAwareApi(true).listSessions({ query: 'login fix', pageSize: 50, localOnly: true });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/sessions?page_size=50&query=login+fix');
  });

  it.each([
    ['beforeId', 'before_id'],
    ['afterId', 'after_id'],
  ] as const)('keeps paging a project with %s on its owning daemon', async (cursor, queryKey) => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 6}`,
      title: 'Test session',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      activity: 'idle',
      cwd: '/srv/app',
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(envelope({ hosts: [] }))
      .mockResolvedValueOnce(envelope({ items: sessions.slice(0, 5), has_more: true }))
      .mockResolvedValueOnce(envelope({ items: sessions.slice(5), has_more: false }));
    const api = new HostRouter(hostAwareApi(true), () => hostAwareApi(false)).createApi();

    const request = { workspaceId: 'wm_1', pageSize: 5, hasPrompt: true };
    const first = await api.listSessions({ ...request, [cursor]: 's5' });
    expect(first).toMatchObject({ hasMore: true, nextPageToken: null });
    const next = await api.listSessions({ ...request, [cursor]: first.items.at(-1)?.id });
    expect(next).toMatchObject({ items: [{ id: 's11' }], hasMore: false });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'http://daemon.test/api/v1/hosts',
      `http://daemon.test/api/v1/sessions?${queryKey}=s5&page_size=5&workspace_id=wm_1&has_prompt=true`,
      `http://daemon.test/api/v1/sessions?${queryKey}=s10&page_size=5&workspace_id=wm_1&has_prompt=true`,
    ]);
  });

  it('never asks a host to list other hosts', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [] }));

    await hostAwareApi(false).listWorkspaces();

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspaces');
  });
});

describe('DaemonKimiWebApi.sessionRating', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['session', 'long_context'] as const)('evaluates a transcript turn for %s', async (survey) => {
    vi.mocked(fetch).mockResolvedValue(envelope({ appearance: { id: 'appearance-1', survey } }));

    await expect(createApi().evaluateSessionRating('session/1', 'transcript-turn-4')).resolves.toEqual({
      appearanceId: 'appearance-1', survey,
    });
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/sessions/session%2F1/rating', 'POST', JSON.stringify({
        op: 'evaluate', turn_id: 'transcript-turn-4',
      })],
    ]);
  });

  it('returns no offer when evaluation is declined', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ appearance: null }));
    await expect(createApi().evaluateSessionRating('session-1', 'turn-1')).resolves.toBeNull();
  });

  it.each([
    { op: 'shown', appearanceId: 'appearance-1' },
    { op: 'abandon', appearanceId: 'appearance-1' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'bad' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'fine' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'good' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'dismissed' },
  ] satisfies AppSessionRatingReport[])('reports $op $response without a view response', async (report) => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    await createApi().reportSessionRating('session/1', report);
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/sessions/session%2F1/rating', 'POST', JSON.stringify({
        op: report.op,
        appearance_id: 'appearance-1',
        response: report.op === 'respond' ? report.response : undefined,
      })],
    ]);
  });

  it('propagates rating errors instead of restoring a server view', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: 40001, msg: 'Invalid turn', data: null, request_id: 'request-1',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    await expect(createApi().evaluateSessionRating('session-1', '')).rejects.toThrow('Invalid turn');
  });
});

describe('DaemonKimiWebApi.remoteControl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the local daemon routes for status, toggle, and device management', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      envelope({
        enabled: false,
        state: 'off',
        devices: [],
        ok: true,
      }),
    );
    const api = createApi();

    await api.getRemoteControlStatus();
    await api.setRemoteControlEnabled(true);
    await api.listRemoteControlDevices();
    await api.renameRemoteControlDevice('device/one', 'Renamed');
    await api.deactivateRemoteControlDevice('device/one');

    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/remote-control', 'GET', undefined],
      ['http://daemon.test/api/v1/remote-control', 'POST', JSON.stringify({ enabled: true })],
      ['http://daemon.test/api/v1/remote-control/devices', 'GET', undefined],
      [
        'http://daemon.test/api/v1/remote-control/devices/device%2Fone',
        'PATCH',
        JSON.stringify({ alias: 'Renamed' }),
      ],
      [
        'http://daemon.test/api/v1/remote-control/devices/device%2Fone/deactivate',
        'POST',
        JSON.stringify({}),
      ],
    ]);
  });

  it('passes daemon errors through to the caller', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ code: 50001, msg: 'cloud unavailable', request_id: 'req_rc' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .listRemoteControlDevices()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 50001, message: 'cloud unavailable', requestId: 'req_rc' });
  });
});

describe('DaemonKimiWebApi.workspaceTrust', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes workspace trust via the workspace routes', async () => {
    vi.mocked(fetch).mockImplementation(async () => envelope({ trusted: true }));
    const api = createApi();

    await expect(api.getWorkspaceTrust('ws/1')).resolves.toEqual({ trusted: true });
    await expect(api.trustWorkspace('ws/1')).resolves.toEqual({ trusted: true });

    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/workspaces/ws%2F1/trust', 'GET', undefined],
      ['http://daemon.test/api/v1/workspaces/ws%2F1/trust', 'POST', JSON.stringify({})],
    ]);
  });
});

describe('DaemonKimiWebApi host management', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists hosts with their connection status', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({
      hosts: [{ id: 'devbox', host: 'dev@example.test', identity_file: '~/.ssh/id', name: 'Dev', status: 'disconnected', connect_error: 'refused', connect_failure: 'connection_refused' }],
    }));

    await expect(createApi().listHosts()).resolves.toEqual([{
      id: 'devbox',
      host: 'dev@example.test',
      identityFile: '~/.ssh/id',
      remoteBin: undefined,
      name: 'Dev',
      enabled: undefined,
      status: 'disconnected',
      remoteVersion: undefined,
      connectError: 'refused',
      connectFailure: 'connection_refused',
    }]);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/hosts');
  });
  it('writes, deletes and connects one host by id', async () => {
    vi.mocked(fetch).mockImplementation(async () => envelope({ ok: true, id: 'dev box', host: 'dev@example.test', status: 'ready' }));
    const api = createApi();

    await api.putHost('dev box', { host: 'dev@example.test', remoteBin: '/opt/kimi', enabled: false });
    await api.deleteHost('dev box');
    await expect(api.connectHost('dev box')).resolves.toMatchObject({ id: 'dev box', status: 'ready' });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['http://daemon.test/api/v1/hosts/dev%20box', 'PUT'],
      ['http://daemon.test/api/v1/hosts/dev%20box', 'DELETE'],
      ['http://daemon.test/api/v1/hosts:connect', 'POST'],
    ]);
    expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({ host: 'dev@example.test', remote_bin: '/opt/kimi', enabled: false });
    expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({ id: 'dev box' });
  });

  it('reports a failed connection test as a result and forwards its abort signal', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ connected: false, connect_error: 'Permission denied', connect_failure: 'authentication_failed' }));
    const controller = new AbortController();

    await expect(createApi().testHost({ host: 'dev@example.test', identityFile: '~/.ssh/id' }, { signal: controller.signal })).resolves.toEqual({
      connected: false,
      remoteVersion: undefined,
      connectError: 'Permission denied',
      connectFailure: 'authentication_failed',
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('http://daemon.test/api/v1/hosts:test');
    expect(JSON.parse(init?.body as string)).toEqual({ host: 'dev@example.test', identity_file: '~/.ssh/id' });
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('maps SSH config hosts', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({
      config_path: '/home/me/.ssh/config',
      exists: true,
      hosts: [{ alias: 'devbox', host_name: 'dev.example.test', user: 'me', port: 2222 }],
    }));

    await expect(createApi().listHostSshConfig()).resolves.toEqual({
      configPath: '/home/me/.ssh/config',
      exists: true,
      hosts: [{ alias: 'devbox', hostName: 'dev.example.test', user: 'me', port: 2222 }],
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/hosts:ssh-hosts');
  });

  it('copies custom providers to a host by id', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({
      providers: ['gateway', 'backup'],
    }));

    await expect(createApi().copyProvidersToHost('devbox')).resolves.toEqual({
      providers: ['gateway', 'backup'],
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('http://daemon.test/api/v1/hosts:copy-providers');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ id: 'devbox' });
  });

  it('forwards the abort signal of a folder browse', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ path: '/srv', parent: '/', entries: [] }));
    const controller = new AbortController();

    await createApi().browseFs('/srv', controller.signal);

    const init = vi.mocked(fetch).mock.calls[0]![1];
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });
});

describe('DaemonKimiWebApi.activateSkill', () => {
  beforeEach(() => { vi.stubGlobal('location', { search: '' }); vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => envelope({ activated: true, skill_name: 'example-skill' }))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps ordered multimodal context and client metadata separate from skill arguments', async () => {
    const metadata = { display_text: 'Save button', kimi_code_composer: { version: 1 } };
    await createApi().activateSkill('session-1', 'example-skill', 'user args', [{ type: 'text', text: 'image_ref=shot-1' }, { type: 'image', source: { kind: 'file', fileId: 'image-1' } }, { type: 'text', text: 'after image' }], { metadata });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.metadata).toEqual(metadata);
    expect(body.args).toBe('user args');
    expect(body.attachments.map((part: { type: string }) => part.type)).toEqual(['text', 'image', 'text']);
    expect(body.attachments[0].text).toBe('image_ref=shot-1');
    expect(body.attachments[1].source.file_id).toBe('image-1');
    expect(body).not.toHaveProperty('content');
  });

  it('sends the selected variant path when provided', async () => {
    await createApi().activateSkill('session-1', 'example-skill', 'user args', undefined, {
      skillPath: '/work/B/example-skill/SKILL.md',
    });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({
      path: '/work/B/example-skill/SKILL.md',
      args: 'user args',
    });
  });

  it('preserves the existing request shape for ordinary skill calls', async () => {
    await createApi().activateSkill('session-1', 'example-skill', 'user args');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual({ args: 'user args' });
  });
});

describe('DaemonKimiWebApi.exportSession', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '?debug=1' });
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('posts the Web log to the encoded session export endpoint and returns the ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="session-export.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess/1', '{"event":"safe"}');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/export',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ web_log: '{"event":"safe"}' }),
    });
    expect(result.fileName).toBe('session-export.zip');
    expect(result.blob.size).toBe(4);
  });

  it('sends the desktop flag only when requested', async () => {
    const zipResponse = () =>
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(zipResponse()));

    await createApi().exportSession('sess_1', 'log', { desktop: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().exportSession('sess_1', 'log');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
  });

  it('retries without the desktop flag when the server predates it', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 40001, msg: 'unrecognized key: desktop', request_id: 'req_old' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="session-export.zip"',
          },
        }),
      );

    const result = await createApi().exportSession('sess_1', 'log', { desktop: true });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
    expect(result.fileName).toBe('session-export.zip');
  });

  it('falls back to a session-id ZIP name for an unsafe response filename', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="../credentials.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess_1');

    expect(result.fileName).toBe('sess_1.zip');
  });

  it('parses a JSON error envelope returned by the export endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ code: 41301, msg: 'export too large', request_id: 'req_server' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .exportSession('sess_1', 'log')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 41301, requestId: 'req_server' });
  });

  it('rejects a successful response whose media type is not a ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('not a zip', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const caught = await createApi().exportSession('sess_1').catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ phase: 'parse', contentType: 'text/plain' });
  });

  it('records only Web-log counts in the request trace', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    const secret = 'PROMPT_CONTENT_MUST_NOT_ENTER_TRACE';

    await createApi().exportSession('sess_1', `${secret}\nsecond line`);

    const trace = JSON.stringify(tracedRequests);
    expect(tracedRequests).not.toHaveLength(0);
    expect(trace).not.toContain(secret);
    expect(trace).toContain('web_log_bytes');
    expect(trace).toContain('web_log_entries');
  });
});

describe('DaemonKimiWebApi.generateSessionTitle', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('posts to the title/generate endpoint and returns the generated title', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 'Fix lint warnings' }));

    const result = await createApi().generateSessionTitle('sess/1');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/title/generate',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(result).toBe('Fix lint warnings');
  });

  it('sends the force flag only when requested', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { force: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().generateSessionTitle('sess_1');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
  });

  it('passes the excerpt source through when given', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { source: 'first_turn' });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ source: 'first_turn' }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().generateSessionTitle('sess_1', { force: true, source: 'digest' });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true, source: 'digest' }),
    });
  });

  it('returns null when generation is unavailable (40922)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40922,
          msg: 'session title generation is unavailable',
          request_id: 'req_1',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null for a bare 404 from a server predating the route', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null on a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null when the success envelope carries no usable title', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({}));

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });
});

describe('DaemonKimiWebApi.listSkills', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  const WIRE_SKILLS = {
    skills: [
      { name: 'custom-theme', description: 'TUI theme', path: 'builtin://custom-theme', source: 'builtin', scopes: ['tui'] },
      { name: 'write-goal', description: 'Goal helper', path: 'builtin://write-goal', source: 'builtin' },
      { name: 'scope-matched', description: 'Scope matched', path: 'builtin://scope-matched', source: 'builtin', scopes: ['test'] },
    ],
  };

  const EXPECTED_SKILLS = [
    { name: 'write-goal', description: 'Goal helper', path: 'builtin://write-goal', source: 'builtin' },
    { name: 'scope-matched', description: 'Scope matched', path: 'builtin://scope-matched', source: 'builtin' },
  ];

  it('drops skills restricted to other scopes from the session listing', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_SKILLS));

    const skills = await createApi().listSkills('sess/1');

    expect(skills).toEqual(EXPECTED_SKILLS);
  });

  it('drops skills restricted to other scopes from the workspace listing', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_SKILLS));

    const skills = await createApi().listSkillsForWorkspace('ws/1');

    expect(skills).toEqual(EXPECTED_SKILLS);
  });
  it('maps workspace_dir for project skill variants', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({
      skills: [{
        name: 'review',
        description: 'Secondary',
        path: '/work/B/review/SKILL.md',
        source: 'project',
        workspace_dir: '/work/B',
      }],
    }));

    const skills = await createApi().listSkillsForWorkspace('ws/1');
    expect(skills).toEqual([{
      name: 'review',
      description: 'Secondary',
      path: '/work/B/review/SKILL.md',
      source: 'project',
      workspaceDir: '/work/B',
    }]);
  });
});

describe('DaemonKimiWebApi request timeout budgets', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const timeoutRejection = () =>
    Promise.reject(new DOMException('signal timed out', 'TimeoutError'));

  it.each(['session', 'media'] as const)('keeps a slow %s feedback upload open until it completes or the caller cancels', async (kind) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const remote = deferredResponse();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const response = await remote.promise;
      init?.signal?.throwIfAborted();
      return response.clone();
    });
    try {
      const api = createApi();
      const upload = (signal?: AbortSignal) => kind === 'session'
        ? api.uploadFeedbackSession(42, 'example-session', signal)
        : api.uploadFeedbackAttachment(42, { kind, file: new Blob(['example']), fileName: 'example.png' }, signal);
      const caller = new AbortController();
      const results = Promise.allSettled([upload(), upload(caller.signal)]);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const callerRequest = vi.mocked(fetch).mock.calls[1]?.[1]?.signal;
      expect(callerRequest?.aborted).toBe(false);
      caller.abort();
      expect(callerRequest?.aborted).toBe(true);
      remote.resolve(envelope({ upload_id: 9 }));
      const [completed, cancelled] = await results;
      expect(completed).toEqual({ status: 'fulfilled', value: { upload_id: 9 } });
      expect(cancelled.status).toBe('rejected');
    } finally {
      remote.resolve(envelope({ upload_id: 9 }));
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('forkSession passes the turn and waits five minutes before aborting', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);

    const caught = await createApi()
      .forkSession('sess_1', { turnIndex: 7 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ timeoutMs: 300_000, phase: 'fetch' });
    expect(isDaemonTimeoutError(caught)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ turn_index: 7 }));
  });

  it('getAgentTurns waits two minutes before aborting', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);

    const caught = await createApi()
      .getAgentTurns('sess_1', 'main', { pageSize: 10 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ timeoutMs: 120_000, phase: 'fetch' });
    expect(isDaemonTimeoutError(caught)).toBe(true);
  });

  it('ordinary session actions keep the default 30s budget', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);
    const api = createApi();

    const caught = await api.undoSession('sess_1', 't_1').catch((error: unknown) => error);
    const predictionError = await api.predictNextPrompt('sess/1', {
      predictionId: 'prediction-1',
      expectedTurnId: 7,
    }).catch((error: unknown) => error);
    const cancelError = await api.cancelPromptPrediction('sess/1', 'prediction-1', 'visibility')
      .catch((error: unknown) => error);

    for (const error of [caught, predictionError, cancelError]) {
      expect(error).toMatchObject({ timeoutMs: 30_000 });
      expect(isDaemonTimeoutError(error)).toBe(true);
    }
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      ['http://daemon.test/api/v1/sessions/sess_1:undo', JSON.stringify({ turn_id: 't_1' })],
      ['http://daemon.test/api/v1/sessions/sess%2F1:predict-prompt', JSON.stringify({ prediction_id: 'prediction-1', expected_turn_id: 7 })],
      ['http://daemon.test/api/v1/sessions/sess%2F1:cancel-prompt-prediction', JSON.stringify({ prediction_id: 'prediction-1', reason: 'visibility' })],
    ]);
  });

  it('a connect failure is not reported as a timeout', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    const caught = await createApi()
      .forkSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(isDaemonTimeoutError(caught)).toBe(false);
  });
});

describe('DaemonKimiWebApi.getAgentTurns', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages older turns by before_ordinal and page_size', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ turns: [], has_more: true }));

    await expect(createApi().getAgentTurns('sess_1', 'agent/2', { beforeOrdinal: 41, pageSize: 20 }))
      .resolves.toEqual({ turns: [], has_more: true });

    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_1/agents/agent%2F2/turns?before_ordinal=41&page_size=20',
    );
  });
});

describe('DaemonKimiWebApi.connectEvents', () => {
  let connection: KimiEventConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    vi.unstubAllGlobals();
  });

  it('projects list-level work facts from the global session event', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'session',
      change: 'updated',
      event_created_at: '2026-01-01T00:00:00.000Z',
      session: {
        id: 'session-1',
        cwd: '/project',
        title: 'Session',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        activity: 'background',
        archived: false,
        pending_interaction: 'question',
      },
    });

    expect(received[0]).toMatchObject({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'question',
      lastTurnReason: undefined,
    });
  });

  it('projects a session title change from the global session event', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'session',
      change: 'updated',
      event_created_at: '2026-01-01T00:00:00.000Z',
      session: {
        id: 'session-1',
        cwd: '/project',
        title: 'Renamed',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        activity: 'idle',
        archived: false,
        last_prompt: 'hello',
      },
    });

    expect(received[0]).toMatchObject({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      session: { title: 'Renamed', lastPrompt: 'hello' },
    });
  });
});

describe('DaemonKimiWebApi.startOAuthLogin', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '?debug=1' });
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PENDING_FLOW = {
    flow_id: 'oauth_1',
    provider: 'kimi-code',
    status: 'pending',
    verification_uri: 'https://example.com/device',
    verification_uri_complete: 'https://example.com/device?code=ABCD',
    user_code: 'ABCD-EFGH',
    expires_in: 900,
    interval: 5,
    expires_at: '2026-01-01T00:15:00.000Z',
  };

  it('posts the picked region and maps the pending flow', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope(PENDING_FLOW));

    const result = await createApi().startOAuthLogin('global');

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ region: 'global' }),
    });
    expect(result).toMatchObject({
      flowId: 'oauth_1',
      status: 'pending',
      verificationUriComplete: 'https://example.com/device?code=ABCD',
    });
  });

  it('sends an empty body when no region is picked', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope(PENDING_FLOW));

    await createApi().startOAuthLogin();

    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
  });

  it('retries once without the region when the server rejects it with 40001', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 40001, msg: 'unrecognized key: region', request_id: 'req_old' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(envelope(PENDING_FLOW));

    const result = await createApi().startOAuthLogin('mainland-cn');

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ region: 'mainland-cn' }),
    });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
    expect(result).toMatchObject({ flowId: 'oauth_1', status: 'pending' });
  });

  it('does not retry on a non-validation error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 50001, msg: 'boom', request_id: 'req_x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(createApi().startOAuthLogin('mainland-cn')).rejects.toThrowError(DaemonApiError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 40001 when no region was sent (nothing to drop)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 40001, msg: 'bad body', request_id: 'req_y' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(createApi().startOAuthLogin()).rejects.toThrowError(DaemonApiError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('DaemonKimiWebApi host files', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an HTTP 200 error envelope instead of reading it as file content', async () => {
    let responseRequestId = '';
    vi.mocked(fetch).mockImplementation((_url, init) => {
      responseRequestId = (init?.headers as Record<string, string>)['X-Request-Id'];
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8', 'content-length': String(body.length) },
      }));
    });

    await expect(createApi().readHostFileContent('/repo/missing.png')).rejects.toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      message: 'path not found',
      requestId: responseRequestId,
    });
    expect(responseRequestId).not.toBe('');
  });

  it('downloads host file bytes with an optional range', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const blob = await createApi().downloadHostFile('/repo/img/a.png', { prefixBytes: 4096 });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/fs:content?path=%2Frepo%2Fimg%2Fa.png',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ Range: 'bytes=0-4095' });
    expect(blob.size).toBe(3);
  });
});

describe('DaemonKimiWebApi session media', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the session-scoped media URL', () => {
    expect(createApi().getSessionMediaUrl('sess/1', 'f_abc')).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/media/f_abc',
    );
  });

  it('fetches session media bytes from the session-scoped route with auth', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const blob = await createApi().getSessionMediaBlob('sess/1', 'f_abc');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/media/f_abc',
    );
    expect(blob.size).toBe(3);
  });

  it('preserves the session_media source kind in prompt submissions', async () => {
    vi.mocked(fetch).mockResolvedValue(
      envelope({
        prompt_id: 'prompt-1',
        user_message_id: 'message-1',
        status: 'running',
        content: [],
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    await createApi().submitPrompt('sess/1', {
      content: [{ type: 'image', source: { kind: 'sessionMedia', fileId: 'f_abc' } }],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/v1/sessions/sess%2F1/prompts');
    if (typeof init.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      content: [{ type: 'image', source: { kind: 'session_media', file_id: 'f_abc' } }],
    });
  });

  it('submits a direct steer to the single-request steer endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({
      prompt_id: 'prompt-1',
      user_message_id: 'message-1',
      status: 'running',
      content: [],
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    await createApi().steerPrompt('sess/1', {
      content: [{ type: 'text', text: 'steer now' }],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/v1/sessions/sess%2F1/steer');
    expect(init.method).toBe('POST');
    if (typeof init.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      content: [{ type: 'text', text: 'steer now' }],
    });
  });
});

describe('DaemonKimiWebApi.suggestFiles abort signal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('forwards the caller signal into the fetch request (combined with the timeout)', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [], truncated: false }));
    const controller = new AbortController();

    await createApi().suggestFiles('ws_1', { query: 'a', limit: 20 }, { signal: controller.signal });

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspace/fs:suggest');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('forwards showHidden in the request body', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFiles('ws_1', { query: '', showHidden: true });

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({ workspace: 'ws_1', query: '', show_hidden: true });
  });

  it('uses the root-scoped suggest route with absolute roots', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFilesAtRoots(['/repo/B'], { query: 'a', showHidden: true });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/fs:suggest');
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      roots: ['/repo/B'],
      query: 'a',
      show_hidden: true,
    });
  });

  it('rethrows the caller-initiated AbortError raw — no network-error wrap, no failure trace', async () => {
    const failures: unknown[] = [];
    const api = new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      tracer: { restFailure: (info) => failures.push(info) },
    });
    vi.mocked(fetch).mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      }));
    const controller = new AbortController();

    const pending = api.suggestFiles('ws_1', { query: 'a' }, { signal: controller.signal });
    const assertion = expect(pending).rejects.toSatisfy(
      (err) => err instanceof DOMException && err.name === 'AbortError',
    );
    controller.abort();
    await assertion;
    expect(failures).toEqual([]);
  });

  it('rethrows the caller-initiated AbortError raw when it fires while reading the body', async () => {
    const failures: unknown[] = [];
    const api = new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      tracer: { restFailure: (info) => failures.push(info) },
    });
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation(async () => {
      const response = new Response('', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      let rejectRead: (err: unknown) => void = () => {};
      const read = new Promise<string>((_resolve, reject) => { rejectRead = reject; });
      const abortRead = (): void => rejectRead(new DOMException('The operation was aborted.', 'AbortError'));
      if (controller.signal.aborted) abortRead();
      else controller.signal.addEventListener('abort', abortRead, { once: true });
      response.text = () => read;
      return response;
    });

    const pending = api.suggestFiles('ws_1', { query: 'a' }, { signal: controller.signal });
    const assertion = expect(pending).rejects.toSatisfy(
      (err) => err instanceof DOMException && err.name === 'AbortError',
    );
    controller.abort();
    await assertion;
    expect(failures).toEqual([]);
  });

  it('keeps the plain timeout signal when no caller signal is given', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFiles('ws_1', { query: 'a' });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

async function flushRequests(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

const EMPTY_SESSIONS_PAGE = { items: [], groups: [], has_more: false, total: 0 };
const WIRE_SESSION = {
  id: 'sess/1',
  title: 'Test',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  cwd: '/project',
  activity: 'idle',
  archived: false,
};

const BACKGROUND_READS: Array<{
  name: string;
  call: (api: DaemonKimiWebApi, options?: ReadRequestOptions) => Promise<unknown>;
  data: unknown;
  path: string;
  method?: string;
  body?: unknown;
}> = [
  { name: 'warnings', call: (api, options) => api.getSessionWarnings('sess/1', options), data: { warnings: [] }, path: '/sessions/sess%2F1/warnings' },
  { name: 'client config', call: (api, options) => api.getClientConfig('model_switch_confirm', options), data: { name: 'model_switch_confirm', config: null }, path: '/client-configs/model_switch_confirm' },
  { name: 'skills', call: (api, options) => api.listSkills('sess/1', options), data: { skills: [] }, path: '/sessions/sess%2F1/skills' },
  { name: 'workspace skills', call: (api, options) => api.listSkillsForWorkspace('ws/1', options), data: { skills: [] }, path: '/workspaces/ws%2F1/skills' },
  { name: 'workspace trust', call: (api, options) => api.getWorkspaceTrust('ws/1', options), data: { trusted: true }, path: '/workspaces/ws%2F1/trust' },
  { name: 'file changes', call: (api, options) => api.getTurnFileChanges('sess/1', 2, options), data: { changes: [] }, path: '/sessions/sess%2F1/file-history/changes?turn_number=2' },
  { name: 'git POST', call: (api, options) => api.getGitStatus('sess/1', { root: '/repo', paths: ['a.ts'] }, options), data: { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 }, path: '/sessions/sess%2F1/fs:git_status', method: 'POST', body: { root: '/repo', paths: ['a.ts'] } },
  { name: 'diff POST', call: (api, options) => api.getFileDiff('sess/1', 'a.ts', { root: '/repo' }, options), data: { path: 'a.ts', diff: '', truncated: false }, path: '/sessions/sess%2F1/fs:diff', method: 'POST', body: { path: 'a.ts', root: '/repo' } },
  { name: 'PR POST', call: (api, options) => api.getPullRequest('sess/1', { root: '/repo' }, options), data: null, path: '/sessions/sess%2F1/fs:pull_request', method: 'POST', body: { root: '/repo' } },
  { name: 'git batch POST', call: (api, options) => api.getGitStatusBatch('sess/1', { roots: ['/repo'], includePullRequest: false }, options), data: { results: {}, errors: {} }, path: '/sessions/sess%2F1/fs:git_status:batch', method: 'POST', body: { roots: ['/repo'], include_pull_request: false } },
  { name: 'PR batch POST', call: (api, options) => api.getPullRequestBatch('sess/1', { roots: ['/repo'] }, options), data: { results: {}, errors: {} }, path: '/sessions/sess%2F1/fs:pull_request:batch', method: 'POST', body: { roots: ['/repo'] } },
];

const MIXED_READS: Array<{
  name: string;
  call: (api: DaemonKimiWebApi, options?: ReadRequestOptions) => Promise<unknown>;
  data: unknown;
  url: string;
}> = [
  { name: 'session', call: (api, options) => api.getSession('sess/1', options), data: WIRE_SESSION, url: 'http://daemon.test/api/v1/sessions/sess%2F1' },
  { name: 'sessions', call: (api, options) => api.listSessions({ include: 'git', pageSize: 2 }, options), data: EMPTY_SESSIONS_PAGE, url: 'http://daemon.test/api/v1/sessions?page_size=2&include=git' },
  { name: 'session groups', call: (api, options) => api.listSessionGroups({ groupPageSize: 2 }, options), data: EMPTY_SESSIONS_PAGE, url: 'http://daemon.test/api/v1/sessions?view=by_workspace&group_page_size=2' },
];

describe('DaemonKimiWebApi background admission', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('does not block conversation pages or user controls behind two background requests', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    const api = createApi();
    const first = api.getSessionWarnings('sess/1');
    const second = api.getSessionWarnings('sess/1');
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith('/turns')) return envelope({ agent_id: 'main', turns: [], has_more: false });
      if (path.endsWith('/prompts')) return envelope({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' });
      if (path.includes('/interactions/')) return envelope({ outcome: 'approved', ended_at: 'now' });
      return envelope({ cancelled: true });
    });

    const turns = api.getAgentTurns('sess/1', 'main', { pageSize: 10 });
    const prompt = api.submitPrompt('sess/1', { content: [{ type: 'text', text: 'test' }] });
    const cancel = api.cancelSession('sess/1');
    const approval = api.respondApproval('sess/1', 'a1', { decision: 'approved' });
    expect(fetch).toHaveBeenCalledTimes(6);
    await expect(turns).resolves.toEqual({ turns: [], has_more: false });
    await expect(prompt).resolves.toMatchObject({ promptId: 'p1' });
    await expect(cancel).resolves.toEqual({ cancelled: true });
    await expect(approval).resolves.toEqual({ outcome: 'approved', endedAt: 'now' });
    expect(tracedRequests.slice(2).every((request) => request.queueMs === undefined)).toBe(true);
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
  });

  it.each(BACKGROUND_READS)('defaults $name to background and forwards cancellation without serializing options', async ({ call, data, path, method, body }) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope(data));
    const api = createApi();
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const controller = new AbortController();
    const defaultRequest = call(api);
    const cancelled = call(api, { signal: controller.signal });
    const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);

    const explicitSignal = new AbortController();
    await call(api, { background: false, signal: explicitSignal.signal });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe(`http://daemon.test/api/v1${path}`);
    expect(vi.mocked(fetch).mock.calls[2]?.[1]).toMatchObject({
      method: method ?? 'GET', body: body === undefined ? undefined : JSON.stringify(body),
    });
    explicitSignal.abort();
    expect(vi.mocked(fetch).mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);

    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second, defaultRequest]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fetch).mock.calls[3]?.[0]).toBe(`http://daemon.test/api/v1${path}`);
  });

  it.each(MIXED_READS)('keeps $name foreground unless explicitly marked background', async ({ call, data, url }) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope(data));
    const api = createApi();
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const controller = new AbortController();
    const background = call(api, { background: true, signal: controller.signal });
    const assertion = expect(background).rejects.toMatchObject({ name: 'AbortError' });
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);
    await call(api);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe(url);
    controller.abort();
    await assertion;
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares the same two-slot FIFO across background reads', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const thirdResponse = deferredResponse();
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementationOnce(() => thirdResponse.promise)
      .mockImplementation(async () => envelope(WIRE_SESSION));
    const api = createApi();
    const first = api.getSessionWarnings('sess/1');
    const second = api.listSessions(undefined, { background: true });
    const third = api.listSessionGroups(undefined, { background: true });
    const fourth = api.getSession('sess/1', { background: true });
    await flushRequests();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'http://daemon.test/api/v1/sessions/sess%2F1/warnings',
      'http://daemon.test/api/v1/sessions',
    ]);
    firstResponse.resolve(envelope({ warnings: [] }));
    await first;
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe('http://daemon.test/api/v1/sessions?view=by_workspace');
    secondResponse.resolve(envelope(EMPTY_SESSIONS_PAGE));
    await second;
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fetch).mock.calls[3]?.[0]).toBe('http://daemon.test/api/v1/sessions/sess%2F1');
    thirdResponse.resolve(envelope(EMPTY_SESSIONS_PAGE));
    await Promise.all([third, fourth]);
  });

  it.each(['http://daemon.test', 'http://other.test'])('isolates another API instance at %s', async (origin) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    vi.mocked(fetch)
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope({ warnings: [] }));
    const api = createApi();
    const otherApi = createApi(origin);
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const queued = api.getSessionWarnings('queued');
    const assertion = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await flushRequests();
    await otherApi.getSessionWarnings('other');
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe(`${origin}/api/v1/sessions/other/warnings`);
    api.dispose();
    await assertion;
    await expect(api.listSessions()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(otherApi.getSessionWarnings('still-open')).resolves.toEqual([]);
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('DaemonKimiWebApi.mkdirFs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the target path to /fs:mkdir and returns the created path', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ path: '/home/user/new-project' }));

    await expect(createApi().mkdirFs('/home/user/new-project')).resolves.toEqual({
      path: '/home/user/new-project',
    });
    expect(vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/fs:mkdir', 'POST', JSON.stringify({ path: '/home/user/new-project' })],
    ]);
  });

  it('propagates DaemonApiError codes when directory creation fails', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40919,
          msg: 'path already exists: /home/user/dup',
          data: null,
          request_id: 'req-mkdir-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createApi().mkdirFs('/home/user/dup')).rejects.toMatchObject({
      name: 'DaemonApiError',
      code: 40919,
    });
  });

  it('posts closeAgent to /sessions/{id}/agents/{agentId}:close and treats 40401 as closed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 40401, msg: 'agent not found', data: null, request_id: 'r1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(createApi().closeAgent('sess/1', 'btw/2')).resolves.toEqual({ closed: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/agents/btw%2F2:close',
    );
  });

  it('posts continueSession to /sessions/{id}:continue', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope({ continued: true }));
    await expect(createApi().continueSession('sess/9')).resolves.toEqual({ continued: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F9:continue',
    );
  });
});
