import { describe, expect, it, vi } from 'vitest';

import { DeviceRouter, type DeviceRoutingControls } from '../src/api/deviceRouting';
import type { DaemonKimiWebApi } from '../src/api/daemon/client';
import type { AppDevice, AppWorkspace, KimiEventHandlers, KimiWebApi } from '../src/api/types';

function workspace(id: string, root = `/${id}`): AppWorkspace {
  return {
    id,
    root,
    name: id,
    kind: 'managed',
    additionalDirs: [],
    sessionCount: 0,
  } as AppWorkspace;
}

function connection() {
  return {
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    watchTaskOutput: vi.fn(),
    unwatchTaskOutput: vi.fn(),
    stopTask: vi.fn(),
    backgroundTask: vi.fn(),
    health: vi.fn(() => ({ connected: true, open: true, stale: false })),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
}

function client(workspaces: AppWorkspace[], overrides: Record<string, unknown> = {}) {
  const stream = connection();
  return {
    stream,
    api: {
      listDevices: vi.fn(async () => [] as AppDevice[]),
      listDeviceSshConfig: vi.fn(async () => ({ configPath: '', exists: false, hosts: [] })),
      connectDevice: vi.fn(async () => undefined),
      listWorkspaces: vi.fn(async () => workspaces),
      listModels: vi.fn(async () => [{ id: 'model' }]),
      readHostFileContent: vi.fn(async () => ({ content: 'file' })),
      uploadFile: vi.fn(async () => ({ id: 'file' })),
      getFileUrl: vi.fn(() => 'url'),
      putDevice: vi.fn(async () => undefined),
      testDevice: vi.fn(async () => ({ connected: true })),
      upgradeDevice: vi.fn(async () => ({ status: 'started' })),
      submitPrompt: vi.fn(async () => ({})),
      updateSession: vi.fn(async () => ({})),
      getPluginInfo: vi.fn(async () => ({})),
      listCapabilities: vi.fn(async () => []),
      getAuth: vi.fn(async () => ({})),
      getUserInfo: vi.fn(async () => ({})),
      getUsage: vi.fn(async () => ({})),
      deleteWorkspace: vi.fn(async () => undefined),
      openInApp: vi.fn(async () => undefined),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'local-model' })),
      setConfig: vi.fn(async () => ({ providers: {} })),
      addWorkspace: vi.fn(async () => workspace('created', '/created')),
      browseFs: vi.fn(async () => ({ path: '/', parent: null, entries: [] })),
      createSession: vi.fn(async () => ({ id: 'new-session' })),
      getSession: vi.fn(async (id: string) => ({ id })),
      findSession: vi.fn(async (id: string): Promise<{ id: string; deviceId?: string }> => ({ id })),
      listSessions: vi.fn(async () => ({ items: [], hasMore: false, nextPageToken: null, total: 0 })),
      archiveSessions: vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) })),
      restoreSessions: vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) })),
      getSessionMediaUrl: vi.fn(() => 'local-media-url'),
      connectEvents: vi.fn(() => stream),
      dispose: vi.fn(),
      ...overrides,
    },
  };
}

function device(id: string, status: AppDevice['status'] = 'ready', extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: id, status, ...extra };
}

async function setup(records: AppDevice[] = [device('dev')], remoteWorkspaces = [workspace('remote-ws')]) {
  const local = client([workspace('local-ws'), ...remoteWorkspaces.map((item) => ({ ...item, deviceId: 'dev' }))]);
  local.api.listDevices.mockResolvedValue(records);
  const remote = client(remoteWorkspaces);
  const router = new DeviceRouter(local.api as unknown as DaemonKimiWebApi, () => remote.api as unknown as DaemonKimiWebApi);
  const api = router.createApi() as KimiWebApi & DeviceRoutingControls;
  return { local, remote, api };
}

describe('DeviceRouter', () => {
  it('sends plain calls to this machine without waiting for device discovery', async () => {
    const { api, local } = await setup();
    local.api.listDevices.mockReturnValue(new Promise(() => undefined) as never);

    await api.readHostFileContent('/file');

    expect(local.api.readHostFileContent).toHaveBeenCalledWith('/file');
  });

  it('takes the projects of every device from this machine as the server tagged them', async () => {
    const { api, remote } = await setup();
    const workspaces = await api.listWorkspaces();

    expect(workspaces.map((item) => [item.id, item.deviceId])).toEqual([
      ['local-ws', undefined],
      ['remote-ws', 'dev'],
    ]);
    expect(remote.api.listWorkspaces).not.toHaveBeenCalled();
  });

  it('routes each call by what it targets, never by the open project', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.listModels();
    await api.readHostFileContent('/same/path');
    await api.uploadFile({ file: new Blob(['x']) });
    await api.getPluginInfo('plugin');
    await api.listCapabilities();
    await api.getAuth();
    await api.getUserInfo();
    await api.getUsage();
    await api.setConfig({ defaultModel: 'model' });
    await api.putDevice('dev', { connection: 'ssh', host: 'dev' });
    await api.testDevice({ connection: 'ssh', host: 'dev' });
    await api.upgradeDevice('dev');

    for (const method of ['listModels', 'readHostFileContent', 'uploadFile', 'getPluginInfo', 'listCapabilities', 'getAuth', 'getUserInfo', 'getUsage', 'setConfig', 'putDevice', 'testDevice', 'upgradeDevice'] as const) {
      expect(local.api[method]).toHaveBeenCalledTimes(1);
      expect(remote.api[method]).not.toHaveBeenCalled();
    }
  });

  it('keeps an uploaded file on the device it was uploaded to', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    remote.api.uploadFile.mockResolvedValue({ id: 'remote-file' });

    const uploaded = await api.uploadFile({ file: new Blob(['x']), deviceId: 'dev' });
    api.getFileUrl(uploaded.id);
    api.getFileUrl('local-file');

    expect(remote.api.uploadFile).toHaveBeenCalledWith({ file: expect.any(Blob) });
    expect(remote.api.getFileUrl).toHaveBeenCalledWith('remote-file');
    expect(local.api.getFileUrl).toHaveBeenCalledWith('local-file');
  });

  it('keeps a session on its device after the active project changes', async () => {
    const { api, remote, local } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });

    await api.submitPrompt(session.id, {} as never);

    expect(remote.api.submitPrompt).toHaveBeenCalledTimes(1);
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
  });

  it('creates remote projects on the device as local projects there', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();

    const created = await api.addWorkspace({ root: '/created', idempotencyKey: 'key', deviceId: 'dev' });

    expect(remote.api.addWorkspace).toHaveBeenCalledWith({ root: '/created', idempotencyKey: 'key' });
    expect(created.deviceId).toBe('dev');
  });

  it('forgets a removed device', async () => {
    const { api, local } = await setup();
    await api.listWorkspaces();
    local.api.listDevices.mockResolvedValue([]);

    await api.listDevices();

    expect(() => api.deviceApi('dev')).toThrow('not configured');
  });

  it('does not create a device when connecting', async () => {
    const { api, local } = await setup();
    local.api.connectDevice.mockResolvedValue(device('dev') as never);

    await expect(api.connectDevice('dev')).resolves.toMatchObject({ id: 'dev' });
    expect(local.api.connectDevice).toHaveBeenCalledWith('dev');
    expect(local.api.putDevice).not.toHaveBeenCalled();
  });

  it('hands out the API of an explicitly picked device', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.deviceApi('dev').browseFs('/srv');
    await api.deviceApi(undefined).browseFs('/home');

    expect(remote.api.browseFs).toHaveBeenCalledWith('/srv');
    expect(local.api.browseFs).toHaveBeenCalledWith('/home');
  });

  it('creates device sessions with exactly the input it is given', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.createSession({ workspaceId: 'remote-ws', planMode: true });
    await api.createSession({ workspaceId: 'local-ws' });

    expect(remote.api.createSession).toHaveBeenCalledWith({ workspaceId: 'remote-ws', planMode: true });
    expect(local.api.createSession).toHaveBeenCalledWith({ workspaceId: 'local-ws' });
    expect(local.api.getConfig).not.toHaveBeenCalled();
  });

  it('reports the device list whenever it changes', async () => {
    const { api, local } = await setup([device('dev', 'pending')]);
    local.api.connectDevice.mockResolvedValue(device('dev', 'pending') as never);
    await api.listWorkspaces();
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    const changes = () => (handlers.onEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);

    local.api.listDevices.mockResolvedValue([device('dev', 'ready')]);
    await api.listDevices();
    await api.listDevices();
    local.api.listDevices.mockResolvedValue([]);
    await api.listDevices();

    expect(changes()).toEqual([
      { type: 'devicesChanged', devices: [expect.objectContaining({ status: 'pending' })] },
      { type: 'devicesChanged', devices: [expect.objectContaining({ status: 'ready' })] },
      { type: 'devicesChanged', devices: [] },
    ]);
  });

  it('leaves connecting pending devices to the server', async () => {
    const { api, local } = await setup([device('dev', 'pending')]);
    await api.listDevices();

    expect(local.api.connectDevice).not.toHaveBeenCalled();
  });

  it('rejects actions that would run on the wrong machine for remote sessions', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });

    await expect(api.openInApp(session.id, 'editor', '/file')).rejects.toThrow('remote device');
    expect(remote.api.openInApp).not.toHaveBeenCalled();
  });

  it('splits batch operations by device', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const response = await api.archiveSessions(['local-session', session.id]);

    expect(local.api.archiveSessions).toHaveBeenCalledWith(['local-session']);
    expect(remote.api.archiveSessions).toHaveBeenCalledWith([session.id]);
    expect(response.results).toHaveLength(2);
  });

  it('does not send a batch operation to this machine when the owner cannot be determined', async () => {
    const { api, local } = await setup();
    const unavailable = Object.assign(new Error('device offline'), { code: 50005 });
    local.api.findSession.mockRejectedValue(unavailable);

    await expect(api.archiveSessions(['remote-session'])).rejects.toBe(unavailable);
    await expect(api.restoreSessions(['remote-session'])).rejects.toBe(unavailable);
    expect(local.api.archiveSessions).not.toHaveBeenCalled();
    expect(local.api.restoreSessions).not.toHaveBeenCalled();
  });

  it('looks up an unknown session before producing its media URL', async () => {
    const { api, local, remote } = await setup();
    local.api.findSession.mockResolvedValue({ id: 'remote-session', deviceId: 'dev' });
    remote.api.getSessionMediaUrl.mockReturnValue('remote-media-url');

    await expect(api.getSessionMediaUrl('remote-session', 'image.png')).resolves.toBe('remote-media-url');
    expect(local.api.findSession).toHaveBeenCalledWith('remote-session');
    expect(remote.api.getSessionMediaUrl).toHaveBeenCalledWith('remote-session', 'image.png');
    expect(local.api.getSessionMediaUrl).not.toHaveBeenCalled();
  });

  it('asks this machine which device owns a session it has not seen yet', async () => {
    const { api, local, remote } = await setup();
    local.api.findSession.mockResolvedValue({ id: 'pinned', deviceId: 'dev' });

    const [session] = await Promise.all([api.getSession('pinned'), api.submitPrompt('pinned', {} as never)]);
    await api.updateSession('pinned', {});

    expect(session).toEqual({ id: 'pinned', deviceId: 'dev' });
    expect(local.api.findSession).toHaveBeenCalledTimes(1);
    expect(local.api.getSession).not.toHaveBeenCalled();
    expect(remote.api.submitPrompt).toHaveBeenCalledWith('pinned', {});
    expect(remote.api.updateSession).toHaveBeenCalledWith('pinned', {});
  });

  it('reports an unreachable owner instead of treating the session as local', async () => {
    const { api, local } = await setup();
    const unavailable = Object.assign(new Error('device offline'), { code: 50005 });
    local.api.findSession.mockRejectedValueOnce(unavailable).mockResolvedValueOnce({ id: 'pinned' });

    await expect(api.submitPrompt('pinned', {} as never)).rejects.toBe(unavailable);
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
    await api.submitPrompt('pinned', {} as never);
    expect(local.api.findSession).toHaveBeenCalledTimes(2);
    expect(local.api.submitPrompt).toHaveBeenCalledWith('pinned', {});
  });

  it('sends sessions straight to this machine when no device is configured', async () => {
    const { api, local } = await setup([]);

    await api.getSession('plain');

    expect(local.api.findSession).not.toHaveBeenCalled();
    expect(local.api.getSession).toHaveBeenCalledWith('plain');
  });

  it('lists sessions of every device through this machine and routes them by the device the server named', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    local.api.listSessions.mockResolvedValue({
      items: [{ id: 'listed-remote', deviceId: 'dev' }, { id: 'listed-local' }],
      hasMore: true,
      nextPageToken: 'merged',
      total: 2,
    } as never);

    const page = await api.listSessions({ pageToken: 'previous' });
    await api.submitPrompt('listed-remote', {} as never);
    await api.submitPrompt('listed-local', {} as never);

    expect(page.nextPageToken).toBe('merged');
    expect(local.api.listSessions).toHaveBeenCalledWith({ pageToken: 'previous' });
    expect(remote.api.listSessions).not.toHaveBeenCalled();
    expect(remote.api.submitPrompt).toHaveBeenCalledWith('listed-remote', {});
    expect(local.api.submitPrompt).toHaveBeenCalledWith('listed-local', {});
  });

  it('routes grouped sessions by the device the server named', async () => {
    const { api, local, remote } = await setup();
    local.api.listSessionGroups = vi.fn(async () => ({
      groups: [{ workspaceId: 'remote-ws', sessions: [{ id: 'grouped-remote', deviceId: 'dev' }], total: 1 }],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    }));

    await api.listSessionGroups({ groupPageSize: 5 }, { background: true });
    await api.submitPrompt('grouped-remote', {} as never);

    expect(remote.api.submitPrompt).toHaveBeenCalledWith('grouped-remote', {});
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
  });

  it('applies a device status event without polling', async () => {
    const { api, local } = await setup([device('dev', 'pending')]);
    await api.listWorkspaces();
    let captured: KimiEventHandlers | undefined;
    local.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      captured = next;
      return local.stream;
    });
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    (handlers.onEvent as ReturnType<typeof vi.fn>).mockClear();
    const listCalls = local.api.listDevices.mock.calls.length;

    captured!.onEvent({ type: 'devicesChanged', devices: [device('dev', 'ready')] }, { sessionId: '' });

    expect(handlers.onEvent).toHaveBeenCalledWith(
      { type: 'devicesChanged', devices: [expect.objectContaining({ status: 'ready' })] },
      { sessionId: '' },
    );
    expect(local.api.listDevices.mock.calls.length).toBe(listCalls);
  });

  it('forwards remote account and plugin events tagged with their device', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    const deviceHandlers = (remote.api.connectEvents.mock.calls as unknown as [KimiEventHandlers][])[0]![0];

    deviceHandlers.onEvent({ type: 'configChanged', changedFields: ['providers'], config: { providers: {} } }, { sessionId: '' });
    deviceHandlers.onEvent({ type: 'modelCatalogChanged', changed: [], unchanged: [], failed: [] }, { sessionId: '' });
    deviceHandlers.onEvent({ type: 'pluginsChanged' }, { sessionId: '' });
    deviceHandlers.onEvent({ type: 'capabilityChanged', capabilityId: 'notify', install: true }, { sessionId: '' });

    expect(handlers.onEvent.mock.calls.slice(1).map(([event, meta]) => [event.type, meta.deviceId])).toEqual([
      ['configChanged', 'dev'],
      ['modelCatalogChanged', 'dev'],
      ['pluginsChanged', 'dev'],
      ['capabilityChanged', 'dev'],
    ]);
  });

  it('reports the first connect of a device stream so late devices get loaded', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;

    api.connectEvents(handlers);
    const deviceHandlers = (remote.api.connectEvents.mock.calls as unknown as [KimiEventHandlers][])[0]![0];
    deviceHandlers.onConnectionChange(true);
    deviceHandlers.onConnectionChange(true);
    expect(handlers.onConnectionChange).toHaveBeenCalledTimes(1);

    deviceHandlers.onConnectionChange(false);
    deviceHandlers.onConnectionChange(true);
    expect(handlers.onConnectionChange).toHaveBeenCalledTimes(2);
    expect(handlers.onConnectionChange).not.toHaveBeenCalledWith(false);
  });

  it('dispatches conversation subscriptions to the stream of the session device', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;
    let deviceHandlers: KimiEventHandlers | undefined;
    remote.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      deviceHandlers = next;
      return remote.stream;
    });

    const events = api.connectEvents(handlers);
    deviceHandlers!.onEvent({ type: 'sessionMetaUpdated', sessionId: session.id, title: 'Remote session' }, { sessionId: session.id });
    await api.submitPrompt(session.id, {} as never);
    expect(remote.api.submitPrompt).toHaveBeenCalledTimes(1);
    events.subscribeConversation(session.id, 'main');
    events.subscribeConversation('local-session', 'main');

    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(local.stream.subscribeConversation).toHaveBeenCalledWith('local-session', 'main');
  });

  it('closes the stream of a disconnected device without surfacing WebSocket errors and resubscribes once ready', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const handlers = { onEvent: vi.fn(), onError: vi.fn(), onConnectionChange: vi.fn() } as unknown as KimiEventHandlers;
    let localHandlers: KimiEventHandlers | undefined;
    let deviceHandlers: KimiEventHandlers | undefined;
    local.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      localHandlers = next;
      return local.stream;
    });
    remote.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      deviceHandlers = next;
      return remote.stream;
    });

    const events = api.connectEvents(handlers);
    events.subscribeConversation(session.id, 'main');
    events.watchTaskOutput(session.id, 'main', 'task-1');
    deviceHandlers!.onError(0, 'WebSocket error', false);
    expect(handlers.onError).not.toHaveBeenCalled();

    localHandlers!.onEvent(
      { type: 'devicesChanged', devices: [{ id: 'dev', connection: 'ssh', host: 'dev.example.test', status: 'disconnected', connectError: 'Connection reset' }] },
      { sessionId: '' },
    );
    expect(remote.stream.close).toHaveBeenCalledTimes(1);

    remote.stream.subscribeConversation.mockClear();
    remote.stream.watchTaskOutput.mockClear();
    local.stream.subscribeConversation.mockClear();
    events.subscribeConversation(session.id, 'sub-1');
    expect(local.stream.subscribeConversation).not.toHaveBeenCalled();

    localHandlers!.onEvent(
      { type: 'devicesChanged', devices: [{ id: 'dev', connection: 'ssh', host: 'dev.example.test', status: 'ready' }] },
      { sessionId: '' },
    );
    expect(remote.api.connectEvents).toHaveBeenCalledTimes(2);
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'sub-1');
    expect(remote.stream.watchTaskOutput).toHaveBeenCalledWith(session.id, 'main', 'task-1');

    remote.stream.subscribeConversation.mockClear();
    remote.stream.watchTaskOutput.mockClear();
    localHandlers!.onEvent(
      { type: 'devicesChanged', devices: [] },
      { sessionId: '' },
    );
    local.api.listWorkspaces.mockResolvedValue([workspace('local-ws'), { ...workspace('remote-ws'), deviceId: 'dev-readded' }]);
    remote.api.listSessions.mockResolvedValue({ items: [{ id: session.id }], hasMore: false, nextPageToken: null, total: 1 } as never);
    localHandlers!.onEvent(
      { type: 'devicesChanged', devices: [{ id: 'dev-readded', connection: 'ssh', host: 'dev.example.test', status: 'ready' }] },
      { sessionId: '' },
    );
    await api.listWorkspaces();
    await api.listSessions({ workspaceId: 'remote-ws' });
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'sub-1');
    expect(remote.stream.watchTaskOutput).toHaveBeenCalledWith(session.id, 'main', 'task-1');
  });
});
