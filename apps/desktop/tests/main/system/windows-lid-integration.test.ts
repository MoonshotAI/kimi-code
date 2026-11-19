import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LidActions } from '../../../src/main/system/windows-lid-state';

const ID = '11111111-1111-1111-1111-111111111111';
let file: string;
let directory: string;
let owner: string;
let power: LidActions;
let failWrite: boolean;
let elevations: number;
let failPreference: boolean;
const preferences: Record<string, boolean> = {};
const legacy: Record<string, Record<string, LidActions>> = {};
const platform = process.platform;

vi.mock('electron', () => ({ app: {} }));
vi.mock('../../../src/main/system/power-save-blocker', () => ({ getPowerSaveBlockerMode: () => 'prevent-app-suspension', setPowerSaveBlockerMode: vi.fn() }));
vi.mock('../../../src/main/app/ui-state', () => ({
  getPreventLidSleep: () => preferences[owner] === true,
  setPreventLidSleep: (value: boolean) => { preferences[owner] = value; },
  savePreventLidSleep: (value: boolean) => {
    if (failPreference) throw new Error('preference write failed');
    preferences[owner] = value;
  },
  getPreventSystemSleep: () => 'prevent-app-suspension',
  setPreventSystemSleep: vi.fn(),
  getWindowsLidActionAcOriginal: () => undefined,
  getWindowsLidActionDcOriginal: () => undefined,
  getWindowsLidBackups: () => structuredClone(legacy[owner] ?? {}),
  saveWindowsLidBackups: (value: Record<string, LidActions>) => { legacy[owner] = structuredClone(value); },
}));
vi.mock('../../../src/main/system/windows-lid-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/system/windows-lid-state')>();
  return { ...actual, withWindowsLidLock: (operation: () => Promise<unknown>) => operation(), openWindowsLidState: () => new actual.WindowsLidState(file, owner) };
});
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    queueMicrotask(() => {
      if (command === 'powercfg') {
        child.stdout.emit('data', Buffer.from(`Power Scheme GUID: ${ID}\nAC: 0x0000000${power.ac}\nDC: 0x0000000${power.dc}`));
      } else {
        elevations++;
        if (failWrite) { child.stderr.emit('data', Buffer.from('cancelled')); child.emit('close', 1); return; }
        const script = Buffer.from(args[2]!.match(/EncodedCommand','([^']+)'/)![1]!, 'base64').toString('utf16le');
        for (const match of script.matchAll(/\/set(ac|dc)valueindex [\da-f-]+ sub_buttons lidaction ([0-3])/g)) power[match[1] as 'ac' | 'dc'] = Number(match[2]);
      }
      child.emit('close', 0);
    });
    return child;
  },
}));

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  directory = mkdtempSync(join(tmpdir(), 'lid-integration-'));
  file = join(directory, 'lid.json');
  owner = 'stable';
  power = { ac: 1, dc: 2 };
  elevations = 0;
  failWrite = false;
  failPreference = false;
  for (const key of Object.keys(preferences)) delete preferences[key];
  for (const key of Object.keys(legacy)) delete legacy[key];
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  rmSync(directory, { recursive: true, force: true });
});

it('coordinates enable, restart and disable across three installations', async () => {
  const { setLidSleepPreventionEnabled: set, applyPreventSleepOnLaunch: launch } = await import('../../../src/main/system/prevent-lid-sleep');
  await set(true);
  owner = 'canary';
  await set(true);
  owner = 'preview';
  await set(true);
  await launch();
  expect(elevations).toBe(1);
  owner = 'stable';
  await set(false);
  expect(power).toEqual({ ac: 0, dc: 0 });
  owner = 'canary';
  await set(false);
  expect(power).toEqual({ ac: 0, dc: 0 });
  owner = 'preview';
  await set(false);
  expect(power).toEqual({ ac: 1, dc: 2 });
  expect(elevations).toBe(2);
});

it('retains shared ownership on failed final restore, then preserves user changes on retry', async () => {
  const { setLidSleepPreventionEnabled: set } = await import('../../../src/main/system/prevent-lid-sleep');
  await set(true);
  owner = 'canary';
  await set(true);
  owner = 'stable';
  await set(false);
  owner = 'canary';
  failWrite = true;
  await expect(set(false)).rejects.toThrow('cancelled');
  expect(preferences['canary']).toBe(true);
  failWrite = false;
  power.dc = 3;
  await set(false);
  expect(power).toEqual({ ac: 1, dc: 3 });
});

it('migrates on launch before another installation captures already modified settings', async () => {
  const { setLidSleepPreventionEnabled: set, applyPreventSleepOnLaunch: launch } = await import('../../../src/main/system/prevent-lid-sleep');
  legacy['stable'] = { [ID]: { ac: 1, dc: 2 } };
  preferences['stable'] = true;
  power = { ac: 0, dc: 0 };
  await launch();
  expect(legacy['stable']).toEqual({});
  owner = 'canary';
  await set(true);
  owner = 'stable';
  await set(false);
  owner = 'canary';
  await set(false);
  expect(power).toEqual({ ac: 1, dc: 2 });
});

it('blocks conflicting legacy migration without changing system values or deleting backups', async () => {
  const { setLidSleepPreventionEnabled: set } = await import('../../../src/main/system/prevent-lid-sleep');
  await set(true);
  owner = 'canary';
  legacy['canary'] = { [ID]: { ac: 0, dc: 0 } };
  await expect(set(true)).rejects.toThrow('Conflicting');
  expect(legacy['canary']).toEqual({ [ID]: { ac: 0, dc: 0 } });
  expect(power).toEqual({ ac: 0, dc: 0 });
  expect(elevations).toBe(1);
});

it('retries after release completed but the local enabled preference was not saved', async () => {
  const { setLidSleepPreventionEnabled: set } = await import('../../../src/main/system/prevent-lid-sleep');
  await set(true);
  await set(false);
  preferences['stable'] = true;
  await set(false);
  expect(preferences['stable']).toBe(false);
  expect(elevations).toBe(2);
  expect(power).toEqual({ ac: 1, dc: 2 });
});

it.each([true, false])('reports repair and allows retry when saving enabled=%s fails', async (enabled) => {
  const { setLidSleepPreventionEnabled: set, getPreventSleepState: state } = await import('../../../src/main/system/prevent-lid-sleep');
  if (!enabled) await set(true);
  failPreference = true;
  await expect(set(enabled)).rejects.toThrow('preference write failed');
  expect((await state()).lidNeedsRepair).toBe(true);
  expect((await state()).lid).toBe(!enabled);
  failPreference = false;
  await set(false);
  expect((await state()).lidNeedsRepair).toBeUndefined();
  expect((await state()).lid).toBe(false);
  expect(power).toEqual({ ac: 1, dc: 2 });
});
