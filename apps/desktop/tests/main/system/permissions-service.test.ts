import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemPermissionsQuery } from '@moonshot-ai/app-core/system-permissions';

const mocks = vi.hoisted(() => ({
  mediaStatus: new Map<string, string>(),
  askForMediaAccess: vi.fn(async (_mediaType: string) => true),
  getSources: vi.fn(async () => [{ id: 'screen:1' }]),
  openExternal: vi.fn(async (_url: string) => undefined),
  probeAvailable: vi.fn(() => true),
  probeLocalNetwork: vi.fn(async (_timeoutMs?: number): Promise<'granted' | 'denied' | 'unavailable'> => 'granted'),
  triggerPrompt: vi.fn(async () => undefined),
  probed: false,
  getProbed: vi.fn((): boolean => mocks.probed),
  setProbed: vi.fn((value: boolean) => { mocks.probed = value; }),
  access: vi.fn(async (_path: string) => undefined),
  execFileAsync: vi.fn(),
}));

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: vi.fn((mediaType: string) => mocks.mediaStatus.get(mediaType) ?? 'granted'),
    askForMediaAccess: mocks.askForMediaAccess,
  },
  desktopCapturer: { getSources: mocks.getSources },
  shell: { openExternal: mocks.openExternal },
}));

vi.mock('../../../src/main/system/local-network', () => ({
  isLocalNetworkProbeAvailable: mocks.probeAvailable,
  probeLocalNetworkPermission: mocks.probeLocalNetwork,
  triggerLocalNetworkPrompt: mocks.triggerPrompt,
}));

vi.mock('../../../src/main/app/ui-state', () => ({
  getLocalNetworkPermissionProbed: mocks.getProbed,
  setLocalNetworkPermissionProbed: mocks.setProbed,
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execFileAsync }),
}));

const realPlatform = process.platform;
let service: typeof import('../../../src/main/system/permissions-service');

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function query(overrides: Partial<SystemPermissionsQuery> = {}): SystemPermissionsQuery {
  return { computerUseInstalled: false, notificationPermission: 'default', ...overrides };
}

beforeEach(async () => {
  vi.resetModules();
  service = await import('../../../src/main/system/permissions-service');
  setPlatform('darwin');
  mocks.mediaStatus.clear();
  mocks.probeAvailable.mockReturnValue(true);
  mocks.probeLocalNetwork.mockResolvedValue('granted');
  mocks.probed = false;
  mocks.access.mockResolvedValue(undefined);
  for (const mock of [
    mocks.askForMediaAccess,
    mocks.getSources,
    mocks.openExternal,
    mocks.probeLocalNetwork,
    mocks.triggerPrompt,
    mocks.setProbed,
    mocks.access,
    mocks.execFileAsync,
  ]) {
    mock.mockClear();
  }
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('parseComputerUsePermissions', () => {
  it('parses both permissions and permissionStatus lines', () => {
    expect(service.parseComputerUsePermissions('ok permissions: accessibility=true screenRecording=false')).toEqual({
      accessibility: true,
      screenRecording: false,
    });
    expect(service.parseComputerUsePermissions('permissionStatus: accessibility=false screenRecording=true')).toEqual({
      accessibility: false,
      screenRecording: true,
    });
    expect(service.parseComputerUsePermissions('unexpected output')).toBeNull();
  });
});

describe('getSystemPermissions', () => {
  it('returns no items off macOS', async () => {
    setPlatform('linux');
    const snapshot = await service.getSystemPermissions(query({ computerUseInstalled: true }));
    expect(snapshot).toEqual({ platform: 'linux', computerUseInstalled: false, items: [] });
  });

  it('aggregates host permissions without probing local network before an explicit request', async () => {
    mocks.mediaStatus.set('screen', 'denied');
    mocks.mediaStatus.set('microphone', 'not-determined');
    mocks.mediaStatus.set('camera', 'restricted');
    const snapshot = await service.getSystemPermissions(query({ notificationPermission: 'denied' }));
    expect(mocks.probeLocalNetwork).not.toHaveBeenCalled();
    expect(snapshot.items).toEqual([
      { id: 'local-network', status: 'not-determined', action: 'request', requiresRestart: false },
      { id: 'screen-recording', status: 'denied', action: 'open-settings', requiresRestart: true },
      { id: 'microphone', status: 'not-determined', action: 'request', requiresRestart: false },
      { id: 'camera', status: 'restricted', action: null, requiresRestart: false },
      { id: 'notifications', status: 'denied', action: 'open-settings', requiresRestart: false },
      { id: 'files-and-folders', status: 'on-demand', action: 'open-settings', requiresRestart: false },
    ]);
  });

  it('probes local network passively after a decision was recorded', async () => {
    mocks.probed = true;
    mocks.probeLocalNetwork.mockResolvedValue('denied');
    const snapshot = await service.getSystemPermissions(query());
    expect(mocks.probeLocalNetwork).toHaveBeenCalledOnce();
    expect(snapshot.items[0]).toEqual({ id: 'local-network', status: 'denied', action: 'open-settings', requiresRestart: false });
  });

  it('reports local network as unavailable when the native module is missing', async () => {
    mocks.probeAvailable.mockReturnValue(false);
    const snapshot = await service.getSystemPermissions(query());
    expect(snapshot.items[0]).toEqual({ id: 'local-network', status: 'unavailable', action: null, requiresRestart: false });
    expect(mocks.probeLocalNetwork).not.toHaveBeenCalled();
  });

  it('maps notification default and granted states', async () => {
    expect((await service.getSystemPermissions(query())).items.find((item) => item.id === 'notifications')).toMatchObject({
      status: 'not-determined',
      action: 'request',
    });
    expect((await service.getSystemPermissions(query({ notificationPermission: 'granted' }))).items.find((item) => item.id === 'notifications')).toMatchObject({
      status: 'granted',
      action: null,
    });
  });

  it('includes Computer Use permissions only when the plugin is installed', async () => {
    mocks.execFileAsync.mockImplementation(async (_bin: string, args: string[]) => {
      expect(args).toEqual(['xpc-ping']);
      return { stdout: 'permissions: accessibility=true screenRecording=false', stderr: '' };
    });
    const withoutCu = await service.getSystemPermissions(query());
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
    expect(withoutCu.items.some((item) => item.id.startsWith('cu-'))).toBe(false);

    const withCu = await service.getSystemPermissions(query({ computerUseInstalled: true }));
    expect(withCu.items.slice(-2)).toEqual([
      { id: 'cu-accessibility', status: 'granted', action: null, requiresRestart: false },
      { id: 'cu-screen-recording', status: 'not-determined', action: 'request', requiresRestart: false },
    ]);
  });

  it('degrades Computer Use permissions when the CLI is missing or fails', async () => {
    mocks.access.mockRejectedValueOnce(new Error('ENOENT'));
    const missing = await service.getSystemPermissions(query({ computerUseInstalled: true }));
    expect(missing.items.slice(-2).map((item) => item.status)).toEqual(['unavailable', 'unavailable']);

    mocks.execFileAsync.mockRejectedValueOnce(new Error('xpc timeout'));
    const failed = await service.getSystemPermissions(query({ computerUseInstalled: true }));
    expect(failed.items.slice(-2).map((item) => item.status)).toEqual(['unavailable', 'unavailable']);
  });
});

describe('requestSystemPermission', () => {
  it('triggers the zero-traffic prompt on local network request and records the decision', async () => {
    mocks.probeLocalNetwork.mockResolvedValue('granted');
    const snapshot = await service.requestSystemPermission('local-network', query());
    expect(mocks.triggerPrompt).toHaveBeenCalledOnce();
    expect(mocks.probeLocalNetwork).toHaveBeenCalledWith(8_000);
    expect(mocks.setProbed).toHaveBeenCalledWith(true);
    expect(snapshot.items[0]).toMatchObject({ id: 'local-network', status: 'granted', action: null });
    mocks.probeLocalNetwork.mockClear();
    await service.getSystemPermissions(query());
    expect(mocks.probeLocalNetwork).toHaveBeenCalledOnce();
  });

  it('does not persist local network probe state when the probe is unavailable', async () => {
    mocks.probeLocalNetwork.mockResolvedValue('unavailable');
    const snapshot = await service.requestSystemPermission('local-network', query());
    expect(mocks.setProbed).not.toHaveBeenCalled();
    expect(snapshot.items[0]).toMatchObject({ id: 'local-network', status: 'unavailable', action: null });
  });

  it('triggers desktopCapturer only when screen recording is not determined', async () => {
    mocks.mediaStatus.set('screen', 'not-determined');
    await service.requestSystemPermission('screen-recording', query());
    expect(mocks.getSources).toHaveBeenCalledOnce();
    mocks.getSources.mockClear();
    mocks.mediaStatus.set('screen', 'denied');
    await service.requestSystemPermission('screen-recording', query());
    expect(mocks.getSources).not.toHaveBeenCalled();
  });

  it.each(['microphone', 'camera'] as const)('requests %s access only when not determined', async (mediaType) => {
    mocks.mediaStatus.set(mediaType, 'not-determined');
    await service.requestSystemPermission(mediaType, query());
    expect(mocks.askForMediaAccess).toHaveBeenCalledExactlyOnceWith(mediaType);
    mocks.askForMediaAccess.mockClear();
    mocks.mediaStatus.set(mediaType, 'granted');
    await service.requestSystemPermission(mediaType, query());
    expect(mocks.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('invokes the KimiCU native permission guide for Computer Use requests', async () => {
    mocks.execFileAsync.mockImplementation(async (_bin: string, args: string[]) => ({
      stdout: args[0] === 'xpc-ping' ? 'permissions: accessibility=true screenRecording=true' : '',
      stderr: '',
    }));
    await service.requestSystemPermission('cu-accessibility', query({ computerUseInstalled: true }));
    expect(mocks.execFileAsync.mock.calls.map((call) => call[1])).toEqual([
      ['request-permissions', '--ax', '--screen'],
      ['xpc-ping'],
    ]);
  });
});

describe('openSystemPermissionSettings', () => {
  it.each([
    ['local-network', 'Privacy_LocalNetwork'],
    ['screen-recording', 'Privacy_ScreenCapture'],
    ['microphone', 'Privacy_Microphone'],
    ['camera', 'Privacy_Camera'],
    ['notifications', 'com.apple.preference.notifications'],
    ['files-and-folders', 'Privacy_FilesAndFolders'],
  ] as const)('opens the macOS pane for %s', async (id, pane) => {
    await service.openSystemPermissionSettings(id, query());
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(pane));
  });
});
