import type { SleepPreventionMode } from '../../../src/shared/prevent-sleep';

import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SCHEME = '11111111-1111-1111-1111-111111111111';
const store: { preventLidSleep?: boolean; preventSystemSleep?: SleepPreventionMode; windowsLidBackups?: Record<string, { ac: number; dc: number }> } = {};
let sharedBackups: Record<string, { ac: number; dc: number }> = {};
let blockerMode: SleepPreventionMode = 'allow-sleep';
const spawnMock = vi.fn();
const existsSyncMock = vi.fn(() => true);

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('../../../src/main/app/ui-state', () => ({
  getPreventLidSleep: vi.fn(() => store.preventLidSleep === true),
  setPreventLidSleep: vi.fn((value: boolean) => { store.preventLidSleep = value; }),
  savePreventLidSleep: vi.fn((value: boolean) => { store.preventLidSleep = value; }),
  getPreventSystemSleep: vi.fn(() => store.preventSystemSleep ?? 'allow-sleep'),
  setPreventSystemSleep: vi.fn((value: SleepPreventionMode) => { store.preventSystemSleep = value; }),
  getWindowsLidActionDcOriginal: vi.fn(() => undefined),
  getWindowsLidActionAcOriginal: vi.fn(() => undefined),
  getWindowsLidBackups: vi.fn(() => structuredClone(store.windowsLidBackups ?? {})),
  saveWindowsLidBackups: vi.fn((value) => { store.windowsLidBackups = structuredClone(value); }),
}));

vi.mock('../../../src/main/system/windows-lid-state', () => ({
  withWindowsLidLock: (operation: () => Promise<unknown>) => operation(),
  openWindowsLidState: () => ({
    migrate: (backups: Record<string, { ac: number; dc: number }>) => { sharedBackups = { ...sharedBackups, ...backups }; },
    claim: (id: string, original: { ac: number; dc: number }) => { sharedBackups[id] ??= original; },
    owned: () => structuredClone(sharedBackups),
    restorable: () => structuredClone(sharedBackups),
    release: () => { sharedBackups = {}; },
    wasReleased: () => false,
  }),
}));

vi.mock('../../../src/main/system/power-save-blocker', () => ({
  getPowerSaveBlockerMode: vi.fn(() => blockerMode),
  setPowerSaveBlockerMode: vi.fn((value: SleepPreventionMode) => { blockerMode = value; }),
}));

type Module = typeof import('../../../src/main/system/prevent-lid-sleep');

let mod: Module;

const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, enumerable: true, configurable: true });
}

function fakeRunProcess(options: { stdout?: string; stderr?: string; status?: number } = {}) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    proc.emit('close', null);
  });
  queueMicrotask(() => {
    if (options.stdout) proc.stdout.emit('data', Buffer.from(options.stdout));
    if (options.stderr) proc.stderr.emit('data', Buffer.from(options.stderr));
    proc.emit('close', options.status ?? 0);
  });
  return proc;
}

function fakeFailingProcess(error: Error) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  queueMicrotask(() => {
    proc.emit('error', error);
  });
  return proc;
}

function fakeInhibitChild(options: { fail?: boolean; silent?: boolean } = {}) {
  const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter };
  proc.kill = vi.fn();
  proc.stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(() => {
    proc.emit('spawn');
    if (options.silent) return;
    if (options.fail) {
      proc.stderr.emit('data', Buffer.from('Access denied'));
      proc.emit('exit', 1, null);
      return;
    }
    proc.stdout.emit('data', Buffer.from('rea'));
    proc.stdout.emit('data', Buffer.from('dy\n'));
  }, 0);
  return proc;
}

function fakeClamshellChild(options: { failStatus?: number; stderr?: string; silent?: boolean } = {}) {
  const proc = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }; stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    if (options.silent) return;
    if (options.failStatus !== undefined) {
      if (options.stderr) proc.stderr.emit('data', Buffer.from(options.stderr));
      proc.emit('exit', options.failStatus, null);
      return;
    }
    proc.stdout.emit('data', Buffer.from('clamshell sleep disabled, holding connection (pid 1)\n'));
  }, 0);
  return proc;
}

const POWERCFG_AC_ONE = `
Power Scheme GUID: 11111111-1111-1111-1111-111111111111  (Balanced)
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      Possible Setting: 000
      Possible Setting: 001
      Current AC Power Setting Index: 0x00000001
      Current DC Power Setting Index: 0x00000001
`;

const POWERCFG_AC_ZERO = POWERCFG_AC_ONE.replaceAll('0x00000001', '0x00000000');

beforeEach(async () => {
  vi.clearAllMocks();
  spawnMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  for (const key of Object.keys(store)) delete store[key as keyof typeof store];
  sharedBackups = {};
  blockerMode = 'allow-sleep';
  vi.resetModules();
  mod = await import('../../../src/main/system/prevent-lid-sleep');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
});

describe('parseWindowsLidActions', () => {
  it('parses the AC index regardless of localized labels', () => {
    expect(mod.parseWindowsLidActions(POWERCFG_AC_ONE)).toEqual({ ac: 1, dc: 1 });
    expect(mod.parseWindowsLidActions(POWERCFG_AC_ZERO)).toEqual({ ac: 0, dc: 0 });
    expect(mod.parseWindowsLidActions('AC: 0x00000002\nDC: 0x00000003')).toEqual({ ac: 2, dc: 3 });
    expect(mod.parseWindowsLidActions('Current AC Power Setting Index: 0x00000001')).toBeUndefined();
    expect(mod.parseWindowsLidActions('garbage')).toBeUndefined();
  });
});

describe('macOS lid sleep prevention', () => {
  beforeEach(() => setPlatform('darwin'));

  it('preserves the enabled preference when quitting before helper readiness', async () => {
    store.preventLidSleep = true;
    const child = fakeClamshellChild({ silent: true });
    spawnMock.mockImplementationOnce(() => child);
    const launch = mod.applyPreventSleepOnLaunch();
    mod.restorePreventSleepBeforeQuit();
    await launch;
    expect(store.preventLidSleep).toBe(true);
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
  });

  it('stops the helper when saving an enabled preference fails', async () => {
    const { savePreventLidSleep } = await import('../../../src/main/app/ui-state');
    vi.mocked(savePreventLidSleep).mockImplementationOnce(() => { throw new Error('disk full'); });
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('disk full');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
    expect(store.preventLidSleep).not.toBe(true);
  });

  it('cancels launch restoration before helper readiness', async () => {
    store.preventLidSleep = true;
    const child = fakeClamshellChild({ silent: true });
    spawnMock.mockImplementationOnce(() => child);
    const launch = mod.applyPreventSleepOnLaunch();
    await mod.setLidSleepPreventionEnabled(false);
    await launch;
    child.stdout.emit('data', Buffer.from('ready'));
    expect(child.kill).toHaveBeenCalled();
    expect(store.preventLidSleep).toBe(false);
    expect((await mod.getPreventSleepState()).lid).toBe(false);
  });

  it('shares macOS readiness and cleans up a startup timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeClamshellChild({ silent: true });
      spawnMock.mockImplementationOnce(() => child);
      const first = expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('timed out');
      const second = expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(3001);
      await Promise.all([first, second]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalled();
      expect(store.preventLidSleep).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves preference on quit and ignores an old helper exit', async () => {
    const first = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => first);
    await mod.setLidSleepPreventionEnabled(true);
    mod.restorePreventSleepBeforeQuit();
    first.emit('exit', 0, null);
    expect(store.preventLidSleep).toBe(true);
    const second = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => second);
    await mod.applyPreventSleepOnLaunch();
    first.emit('exit', 0, null);
    expect(store.preventLidSleep).toBe(true);
    await mod.setLidSleepPreventionEnabled(false);
    expect(second.kill).toHaveBeenCalled();
  });

  it('holds a resident helper while enabled and links system sleep prevention', async () => {
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    const state = await mod.setLidSleepPreventionEnabled(true);
    expect(spawnMock).toHaveBeenCalledWith(join('/app', 'native', 'clamshell-tool', 'dist', 'clamshell-tool'), [], expect.anything());
    expect(state).toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
    expect(store.preventLidSleep).toBe(true);
    expect(store.preventSystemSleep).toBe('prevent-app-suspension');
    expect(blockerMode).toBe('prevent-app-suspension');
  });

  it('throws without persisting when the helper fails', async () => {
    spawnMock.mockImplementationOnce(() => fakeClamshellChild({ failStatus: 2, stderr: 'IOConnectCallScalarMethod failed: 0xe00002c9' }));
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('IOConnectCallScalarMethod failed');
    expect(store.preventLidSleep).toBeUndefined();
    expect(blockerMode).toBe('allow-sleep');
  });

  it('throws when the helper binary is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('unsupported');
  });

  it('disables by killing the resident helper', async () => {
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);

    const state = await mod.setLidSleepPreventionEnabled(false);
    expect(child.kill).toHaveBeenCalled();
    expect(state.lid).toBe(false);
    expect(store.preventLidSleep).toBe(false);
  });

  it('reverts the persisted flag when the helper child dies', async () => {
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    expect(store.preventLidSleep).toBe(true);

    child.emit('exit', 1, null);
    expect(store.preventLidSleep).toBe(false);
  });

  it('respawns the resident helper on launch when persisted on', async () => {
    store.preventLidSleep = true;
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.applyPreventSleepOnLaunch();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(store.preventLidSleep).toBe(true);
  });

  it('does nothing on launch when persisted off', async () => {
    await mod.applyPreventSleepOnLaunch();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('clears the persisted lid flag when launch enable fails', async () => {
    store.preventLidSleep = true;
    spawnMock.mockImplementationOnce(() => fakeClamshellChild({ failStatus: 1, stderr: 'broken' }));
    await mod.applyPreventSleepOnLaunch();
    expect(store.preventLidSleep).toBe(false);
  });

  it('kills the helper on quit', async () => {
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    mod.restorePreventSleepBeforeQuit();
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('windows lid sleep prevention', () => {
  beforeEach(() => setPlatform('win32'));

  it.each(['enabled', 'backup', 'none'])('handles unavailable powercfg with %s state', async (state) => {
    if (state === 'enabled') store.preventLidSleep = true;
    if (state === 'backup') store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 2 } };
    spawnMock.mockImplementationOnce(() => fakeFailingProcess(new Error('powercfg unavailable')));
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(state === 'none' ? undefined : true);
  });

  it('marks unparseable powercfg output as needing repair when enabled', async () => {
    store.preventLidSleep = true;
    mockQuerySequence('invalid output');
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(true);
  });

  it('does not elevate when saving the backup fails', async () => {
    const { saveWindowsLidBackups } = await import('../../../src/main/app/ui-state');
    vi.mocked(saveWindowsLidBackups).mockImplementationOnce(() => { throw new Error('disk full'); });
    mockQuerySequence(POWERCFG_AC_ONE, POWERCFG_AC_ONE);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('disk full');
    expect(spawnMock.mock.calls.every(([command]) => command === 'powercfg')).toBe(true);
    expect(store.preventLidSleep).not.toBe(true);
  });

  it('backs up and restores each modified power scheme independently', async () => {
    const schemeB = '22222222-2222-2222-2222-222222222222';
    const originalB = POWERCFG_AC_ONE.replaceAll(SCHEME, schemeB).replaceAll('0x00000001', '0x00000002');
    const zeroB = POWERCFG_AC_ZERO.replaceAll(SCHEME, schemeB);
    mockQuerySequence(POWERCFG_AC_ONE);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    mockQuerySequence(originalB);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(zeroB);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups).toEqual({ [SCHEME]: { ac: 1, dc: 1 }, [schemeB]: { ac: 2, dc: 2 } });
    mockQuerySequence(POWERCFG_AC_ZERO, zeroB);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ONE, originalB);
    await mod.setLidSleepPreventionEnabled(false);
    const commands = spawnMock.mock.calls.filter(([command]) => command === 'powershell').map(([, args]) => {
      return Buffer.from(String(args[2]).match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le');
    });
    expect(commands[2]).toContain(`/setacvalueindex ${SCHEME} sub_buttons lidaction 1`);
    expect(commands[2]).toContain(`/setdcvalueindex ${schemeB} sub_buttons lidaction 2`);
    expect(commands).toHaveLength(3);
    expect(sharedBackups).toEqual({});
  });

  function mockQuerySequence(...outputs: string[]): void {
    for (const stdout of outputs) {
      spawnMock.mockImplementationOnce(() => fakeRunProcess({ stdout }));
    }
  }

  it.each(['ac', 'dc'] as const)('preserves external changes to %s and restores only the other source', async (source) => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 1 } };
    const current = `Power Scheme GUID: ${SCHEME}\nAC: 0x0000000${source === 'ac' ? 3 : 0}\nDC: 0x0000000${source === 'dc' ? 2 : 0}`;
    const restored = `Power Scheme GUID: ${SCHEME}\nAC: 0x0000000${source === 'ac' ? 3 : 1}\nDC: 0x0000000${source === 'dc' ? 2 : 1}`;
    mockQuerySequence(current);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(restored);
    await mod.setLidSleepPreventionEnabled(false);
    const command = String(spawnMock.mock.calls[1]?.[1]?.[2]);
    const inner = Buffer.from(command.match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le');
    expect(inner).not.toContain(`/set${source}valueindex`);
    expect(inner).toContain(`/set${source === 'ac' ? 'dc' : 'ac'}valueindex`);
    expect(sharedBackups).toEqual({});
  });

  it('does not elevate when both sources were changed externally', async () => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 1 } };
    mockQuerySequence(`Power Scheme GUID: ${SCHEME}\nAC: 0x00000002\nDC: 0x00000003`);
    await mod.setLidSleepPreventionEnabled(false);
    expect(spawnMock.mock.calls.every(([command]) => command === 'powercfg')).toBe(true);
    expect(sharedBackups).toEqual({});
  });

  it('drops only confirmed deleted plans and restores the remaining plan', async () => {
    const deleted = '22222222-2222-2222-2222-222222222222';
    store.preventLidSleep = true;
    store.windowsLidBackups = { [deleted]: { ac: 2, dc: 3 }, [SCHEME]: { ac: 1, dc: 1 } };
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1 }));
    mockQuerySequence(`Power Scheme GUID: ${SCHEME} (Balanced) *`, POWERCFG_AC_ZERO);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ONE);
    await mod.setLidSleepPreventionEnabled(false);
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['/list']);
    const command = String(spawnMock.mock.calls[3]?.[1]?.[2]);
    const inner = Buffer.from(command.match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le');
    expect(inner).toContain(SCHEME);
    expect(inner).not.toContain(deleted);
    expect(sharedBackups).toEqual({});
  });

  it.each(['present', 'unavailable', 'malformed'])('retains backups when plan deletion is not confirmed: %s', async (failure) => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 2 } };
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1 }));
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: failure === 'unavailable' ? 1 : 0, stdout: failure === 'present' ? SCHEME : 'invalid' }));
    await expect(mod.setLidSleepPreventionEnabled(false)).rejects.toThrow();
    expect(sharedBackups).toEqual({ [SCHEME]: { ac: 1, dc: 2 } });
    expect(store.preventLidSleep).toBe(true);
    expect(spawnMock.mock.calls.every(([command]) => command === 'powercfg')).toBe(true);
  });

  it('retains every backup after a partially applied batch restore', async () => {
    const other = '22222222-2222-2222-2222-222222222222';
    store.preventLidSleep = true;
    const backups = { [SCHEME]: { ac: 1, dc: 1 }, [other]: { ac: 2, dc: 3 } };
    store.windowsLidBackups = structuredClone(backups);
    mockQuerySequence(POWERCFG_AC_ZERO, POWERCFG_AC_ZERO.replaceAll(SCHEME, other));
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1, stderr: 'partial failure' }));
    await expect(mod.setLidSleepPreventionEnabled(false)).rejects.toThrow('partial failure');
    expect(sharedBackups).toEqual(backups);
    expect(store.preventLidSleep).toBe(true);
    expect(spawnMock.mock.calls.filter(([command]) => command === 'powershell')).toHaveLength(1);
  });

  it('stores the original value, elevates once and verifies the write', async () => {
    mockQuerySequence(POWERCFG_AC_ONE);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);

    const state = await mod.setLidSleepPreventionEnabled(true);

    expect(sharedBackups?.[SCHEME]?.ac).toBe(1);
    const elevate = spawnMock.mock.calls[1];
    expect(elevate?.[0]).toBe('powershell');
    expect(Buffer.from(String(elevate?.[1]?.[2]).match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le')).toContain('/setdcvalueindex 11111111-1111-1111-1111-111111111111 sub_buttons lidaction 0');
    expect(String(elevate?.[1]?.[2])).toContain('RunAs');
    expect(state).toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
  });

  it('does not elevate when the AC value is already do-nothing', async () => {
    mockQuerySequence(POWERCFG_AC_ZERO);
    const state = await mod.setLidSleepPreventionEnabled(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(state.lid).toBe(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(0);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(0);
  });

  it('includes hidden lid settings when querying localized power plans', async () => {
    const hiddenSettings = [
      '电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡)',
      '  子组 GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (电源按钮和盖子)',
      '    电源设置 GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (合上盖子操作)',
      '      可能的设置索引: 000',
      '      可能的设置友好名称: 不采取任何操作',
      '    当前交流电源设置索引: 0x00000000',
      '    当前直流电源设置索引: 0x00000000',
    ].join('\r\n');
    spawnMock.mockImplementation((_command: string, args: string[]) => fakeRunProcess({
      stdout: args[0] === '/qh' ? hiddenSettings : hiddenSettings.split('\r\n')[0],
    }));

    expect((await mod.setLidSleepPreventionEnabled(true)).lid).toBe(true);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith('powercfg', ['/qh', 'scheme_current', 'sub_buttons', 'lidaction'], expect.anything());
  });

  it('throws when the query fails', async () => {
    spawnMock.mockImplementationOnce(() => fakeFailingProcess(new Error('spawn powercfg ENOENT')));
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('query failed');
    expect(store.preventLidSleep).toBeUndefined();
  });

  it('throws when the elevated write does not stick', async () => {
    mockQuerySequence(POWERCFG_AC_ONE);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ONE);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('was not applied');
    expect(store.preventLidSleep).toBeUndefined();
  });

  it('restores the original value on disable', async () => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 2, dc: 1 } };
    mockQuerySequence(POWERCFG_AC_ZERO);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ONE.replace('0x00000001', '0x00000002'));

    await mod.setLidSleepPreventionEnabled(false);
    const elevate = spawnMock.mock.calls[1];
    expect(Buffer.from(String(elevate?.[1]?.[2]).match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le')).toContain('/setacvalueindex 11111111-1111-1111-1111-111111111111 sub_buttons lidaction 2');
    expect(store.preventLidSleep).toBe(false);
  });

  it('reconciles read-only on launch and reports repair state', async () => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 1 } };
    mockQuerySequence(POWERCFG_AC_ONE);
    await mod.applyPreventSleepOnLaunch();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(String(spawnMock.mock.calls[0]?.[0])).toBe('powercfg');
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(true);

    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBeUndefined();

    store.preventLidSleep = false;
    store.windowsLidBackups = { [SCHEME]: { ac: 1, dc: 1 } };
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(true);

    mockQuerySequence(POWERCFG_AC_ONE);
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(true);
  });

  it('does not touch anything on quit', () => {
    store.preventLidSleep = true;
    mod.restorePreventSleepBeforeQuit();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('restores different AC and DC originals and captures fresh values next time', async () => {
    const original = POWERCFG_AC_ONE.replace('Current AC Power Setting Index: 0x00000001', 'Current AC Power Setting Index: 0x00000002').replace('Current DC Power Setting Index: 0x00000001', 'Current DC Power Setting Index: 0x00000003');
    mockQuerySequence(original);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(2);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(3);
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(2);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(3);

    mockQuerySequence(POWERCFG_AC_ZERO);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(original);
    await mod.setLidSleepPreventionEnabled(false);
    expect(sharedBackups?.[SCHEME]?.ac).toBeUndefined();
    expect(sharedBackups?.[SCHEME]?.dc).toBeUndefined();
    const command = String(spawnMock.mock.calls.at(-2)?.[1]?.[2]);
    const inner = Buffer.from(command.match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le');
    expect(inner).toContain('/setacvalueindex 11111111-1111-1111-1111-111111111111 sub_buttons lidaction 2');
    expect(inner).toContain('/setdcvalueindex 11111111-1111-1111-1111-111111111111 sub_buttons lidaction 3');

    mockQuerySequence(POWERCFG_AC_ONE);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(1);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(1);
  });

  it('preserves an existing plan backup on repeated enable', async () => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 2, dc: 1 } };
    mockQuerySequence(POWERCFG_AC_ONE.replace('Current AC Power Setting Index: 0x00000001', 'Current AC Power Setting Index: 0x00000000'));
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(2);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(1);
  });

  it('keeps both backups after a partial write and reports repair on launch', async () => {
    const partial = POWERCFG_AC_ONE.replace('Current AC Power Setting Index: 0x00000001', 'Current AC Power Setting Index: 0x00000000');
    mockQuerySequence(POWERCFG_AC_ONE);
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1 }));
    mockQuerySequence(partial);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('write failed');
    expect(sharedBackups?.[SCHEME]?.ac).toBe(1);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(1);
    mockQuerySequence(partial);
    await mod.applyPreventSleepOnLaunch();
    expect((await mod.getPreventSleepState()).lidNeedsRepair).toBe(true);
    mockQuerySequence(partial);
    spawnMock.mockImplementationOnce(() => fakeRunProcess());
    mockQuerySequence(POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(1);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(1);
  });

  it('retains the enabled flag and backups when restoring fails', async () => {
    store.preventLidSleep = true;
    store.windowsLidBackups = { [SCHEME]: { ac: 2, dc: 3 } };
    mockQuerySequence(POWERCFG_AC_ZERO);
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1, stderr: 'cancelled' }));
    await expect(mod.setLidSleepPreventionEnabled(false)).rejects.toThrow('cancelled');
    expect(store.preventLidSleep).toBe(true);
    expect(sharedBackups?.[SCHEME]?.ac).toBe(2);
    expect(sharedBackups?.[SCHEME]?.dc).toBe(3);
  });

  it('leaves existing do-nothing settings unchanged after an enable-disable cycle', async () => {
    mockQuerySequence(POWERCFG_AC_ZERO, POWERCFG_AC_ZERO);
    await mod.setLidSleepPreventionEnabled(true);
    await mod.setLidSleepPreventionEnabled(false);
    expect(spawnMock.mock.calls.every(([command]) => command === 'powercfg')).toBe(true);
    expect(store.preventLidSleep).toBe(false);
  });
});

describe('linux lid sleep prevention', () => {
  it('preserves the enabled preference when quitting before inhibitor readiness', async () => {
    setPlatform('linux');
    store.preventLidSleep = true;
    const child = fakeInhibitChild({ silent: true });
    spawnMock.mockImplementationOnce(() => child);
    const launch = mod.applyPreventSleepOnLaunch();
    mod.restorePreventSleepBeforeQuit();
    await launch;
    expect(store.preventLidSleep).toBe(true);
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
  });
  beforeEach(() => setPlatform('linux'));

  it('reports unsupported when installed tools cannot reach logind', async () => {
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ status: 1, stderr: 'Failed to connect to bus' }));
    expect((await mod.getPreventSleepState()).lidSupported).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith('systemd-inhibit', ['--list', '--no-pager'], expect.anything());
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('unsupported');
    expect(store.preventLidSleep).not.toBe(true);
  });

  function mockProbeAvailable(): void {
    spawnMock.mockImplementationOnce(() => fakeRunProcess({ stdout: 'systemd 255' }));
  }

  it('reports unsupported without systemd-inhibit', async () => {
    spawnMock.mockImplementationOnce(() => fakeFailingProcess(new Error('ENOENT')));
    expect((await mod.getPreventSleepState()).lidSupported).toBe(false);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('unsupported');
  });

  it('holds an inhibitor child while enabled and kills it on disable', async () => {
    mockProbeAvailable();
    const child = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => child);

    const state = await mod.setLidSleepPreventionEnabled(true);
    expect(state).toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
    expect(spawnMock).toHaveBeenLastCalledWith(
      'systemd-inhibit',
      ['--what=handle-lid-switch', '--mode=block', '--who=Kimi Code', '--why=Kimi Code 合盖不休眠', 'sh', '-c', 'printf "ready\\n"; read -r lifetime'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    spawnMock.mockImplementationOnce(() => fakeRunProcess({ stdout: 'systemd 255' }));
    await mod.setLidSleepPreventionEnabled(false);
    expect(child.kill).toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
    expect(store.preventLidSleep).toBe(false);
  });

  it('rejects acquisition failures after spawn without enabling sleep prevention', async () => {
    mockProbeAvailable();
    const child = fakeInhibitChild({ fail: true });
    spawnMock.mockImplementationOnce(() => child);
    await expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('Access denied');
    expect(store.preventLidSleep).not.toBe(true);
    expect(blockerMode).toBe('allow-sleep');
    expect(child.stdin.destroy).toHaveBeenCalled();
  });

  it('shares the readiness check between concurrent enable requests', async () => {
    mockProbeAvailable();
    await mod.getPreventSleepState();
    const child = fakeInhibitChild({ fail: true });
    spawnMock.mockImplementationOnce(() => child);
    const results = await Promise.allSettled([
      mod.setLidSleepPreventionEnabled(true),
      mod.setLidSleepPreventionEnabled(true),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(store.preventLidSleep).not.toBe(true);
  });

  it('times out and releases an inhibitor that never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      mockProbeAvailable();
      const child = fakeInhibitChild({ silent: true });
      spawnMock.mockImplementationOnce(() => child);
      const result = expect(mod.setLidSleepPreventionEnabled(true)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(3001);
      await result;
      expect(child.kill).toHaveBeenCalled();
      expect(child.stdin.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a previous inhibitor exit after re-enabling', async () => {
    mockProbeAvailable();
    const first = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => first);
    await mod.setLidSleepPreventionEnabled(true);
    await mod.setLidSleepPreventionEnabled(false);
    const second = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => second);
    await mod.setLidSleepPreventionEnabled(true);
    first.emit('exit', null, 'SIGTERM');
    expect((await mod.getPreventSleepState()).lid).toBe(true);
    await mod.setLidSleepPreventionEnabled(false);
    expect(second.kill).toHaveBeenCalled();
  });

  it('preserves the preference when the stopped inhibitor exits during quit', async () => {
    mockProbeAvailable();
    const child = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    mod.restorePreventSleepBeforeQuit();
    child.emit('exit', null, 'SIGTERM');
    expect(store.preventLidSleep).toBe(true);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('reverts the persisted flag when the inhibitor child dies', async () => {
    mockProbeAvailable();
    const child = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    expect(store.preventLidSleep).toBe(true);

    child.emit('exit', 1, null);
    expect(store.preventLidSleep).toBe(false);
  });

  it('respawns the inhibitor on launch when persisted on', async () => {
    store.preventLidSleep = true;
    const child = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.applyPreventSleepOnLaunch();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(store.preventLidSleep).toBe(true);
  });

  it('kills the inhibitor on quit', async () => {
    mockProbeAvailable();
    const child = fakeInhibitChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    mod.restorePreventSleepBeforeQuit();
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('system sleep prevention linkage', () => {
  beforeEach(() => setPlatform('darwin'));

  it('preserves display prevention when lid prevention is enabled or disabled', async () => {
    await mod.setSystemSleepPreventionEnabled('prevent-display-sleep');
    spawnMock.mockImplementationOnce(() => fakeClamshellChild());
    expect((await mod.setLidSleepPreventionEnabled(true)).system).toBe('prevent-display-sleep');
    expect((await mod.setLidSleepPreventionEnabled(false)).system).toBe('prevent-display-sleep');
    expect(store.preventSystemSleep).toBe('prevent-display-sleep');
  });

  it('restores display prevention on launch', async () => {
    store.preventSystemSleep = 'prevent-display-sleep';
    await mod.applyPreventSleepOnLaunch();
    expect(blockerMode).toBe('prevent-display-sleep');
  });

  it('retains the active mode when disabling lid prevention fails', async () => {
    setPlatform('win32');
    store.preventLidSleep = true;
    await mod.setSystemSleepPreventionEnabled('prevent-display-sleep');
    spawnMock.mockImplementationOnce(() => fakeFailingProcess(new Error('query failed')));
    await expect(mod.setSystemSleepPreventionEnabled('allow-sleep')).rejects.toThrow();
    expect(blockerMode).toBe('prevent-display-sleep');
    expect(store.preventSystemSleep).toBe('prevent-display-sleep');
    expect(store.preventLidSleep).toBe(true);
  });

  it('cascades lid prevention off when system prevention is disabled', async () => {
    const child = fakeClamshellChild();
    spawnMock.mockImplementationOnce(() => child);
    await mod.setLidSleepPreventionEnabled(true);
    expect(store.preventLidSleep).toBe(true);

    const state = await mod.setSystemSleepPreventionEnabled('allow-sleep');
    expect(child.kill).toHaveBeenCalled();
    expect(store.preventLidSleep).toBe(false);
    expect(state).toEqual({ system: 'allow-sleep', lid: false, lidSupported: true });
    expect(blockerMode).toBe('allow-sleep');
  });

  it('does not touch lid prevention when system prevention is enabled', async () => {
    const state = await mod.setSystemSleepPreventionEnabled('prevent-app-suspension');
    expect(state.system).toBe('prevent-app-suspension');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(store.preventSystemSleep).toBe('prevent-app-suspension');
  });
});
