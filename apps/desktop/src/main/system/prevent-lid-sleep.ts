import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getPowerSaveBlockerMode, setPowerSaveBlockerMode } from './power-save-blocker';
import { openWindowsLidState, withWindowsLidLock } from './windows-lid-state';
import type { PreventSleepState, SleepPreventionMode } from '../../shared/prevent-sleep';
import {
  getPreventLidSleep as getPersistedLidSleep,
  getPreventSystemSleep as getPersistedSystemSleep,
  getWindowsLidActionAcOriginal,
  getWindowsLidActionDcOriginal,
  setPreventLidSleep as persistLidSleep,
  savePreventLidSleep,
  setPreventSystemSleep as persistSystemSleep,
  getWindowsLidBackups,
  saveWindowsLidBackups,
} from '../app/ui-state';

const LID_SLEEP_HELPER_TIMEOUT_MS = 3_000;
const WINDOWS_LIDACTION_DO_NOTHING = 0;

let windowsLidNeedsRepair = false;
let windowsLidOperation: Promise<unknown> = Promise.resolve();
let linuxInhibitChild: ChildProcess | undefined;
let linuxInhibitStarting: Promise<void> | undefined;
let linuxInhibitSupported: boolean | undefined;
let macClamshellChild: ChildProcess | undefined;
let macClamshellStarting: Promise<void> | undefined;
let cancelMacClamshellStart: (() => void) | undefined;
let cancelLinuxInhibitStart: (() => void) | undefined;
let quitGeneration = 0;

function clamshellToolPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'clamshell-tool', 'clamshell-tool')
    : join(app.getAppPath(), 'native', 'clamshell-tool', 'dist', 'clamshell-tool');
}

function runProcess(command: string, args: string[], timeoutMs = LID_SLEEP_HELPER_TIMEOUT_MS): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runChecked(command: string, args: string[]): Promise<string> {
  const result = await runProcess(command, args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout;
}

async function enableMacLidSleepPrevention(): Promise<void> {
  if (macClamshellStarting !== undefined) return macClamshellStarting;
  if (macClamshellChild !== undefined) return;
  macClamshellStarting = startMacLidSleepPrevention();
  try {
    await macClamshellStarting;
  } finally {
    macClamshellStarting = undefined;
  }
}

async function startMacLidSleepPrevention(): Promise<void> {
  const child = spawn(clamshellToolPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  macClamshellChild = child;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on('exit', () => {
    if (macClamshellChild !== child) return;
    macClamshellChild = undefined;
    if (getPersistedLidSleep()) persistLidSleep(false);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('clamshell-tool timed out')), LID_SLEEP_HELPER_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelMacClamshellStart = undefined;
        child.stdout.off('data', onReady);
        if (error) reject(error);
        else resolve();
      };
      const onReady = (): void => finish();
      cancelMacClamshellStart = () => finish(new Error('clamshell-tool start cancelled'));
      child.stdout.once('data', onReady);
      child.once('exit', (status) => finish(new Error(stderr.trim() || `clamshell-tool exited with ${status}`)));
      child.once('error', (error) => finish(error));
      child.stdin.on('error', (error) => finish(error));
    });
    if (macClamshellChild !== child) throw new Error('clamshell-tool stopped before activation');
  } catch (error) {
    if (macClamshellChild === child) macClamshellChild = undefined;
    child.stdin.destroy();
    child.kill();
    throw error;
  }
}

function disableMacLidSleepPrevention(): void {
  const child = macClamshellChild;
  macClamshellChild = undefined;
  cancelMacClamshellStart?.();
  child?.stdin?.end();
  child?.kill();
}

export function parseWindowsLidActions(output: string): { ac: number; dc: number } | undefined {
  const matches = [...output.matchAll(/:\s*0x([0-9a-fA-F]{8})\s*$/gm)];
  if (matches.length !== 2) return undefined;
  const ac = Number.parseInt(matches[0]![1]!, 16);
  const dc = Number.parseInt(matches[1]![1]!, 16);
  return ac <= 3 && dc <= 3 ? { ac, dc } : undefined;
}

async function queryWindowsLidActions(scheme = 'scheme_current'): Promise<{ scheme: string; ac: number; dc: number } | undefined> {
  try {
    const stdout = await runChecked('powercfg', ['/qh', scheme, 'sub_buttons', 'lidaction']);
    const id = stdout.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
    const actions = parseWindowsLidActions(stdout);
    return id && actions ? { scheme: id, ...actions } : undefined;
  } catch {
    return undefined;
  }
}

async function writeWindowsLidActions(actions: Array<{ scheme: string; ac?: number; dc?: number }>): Promise<void> {
  const commands = actions.map(({ scheme, ac, dc }) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scheme) || ![ac, dc].every((value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 3))) throw new Error('Invalid lid backup');
    return ([['ac', ac], ['dc', dc]] as const).filter(([, value]) => value !== undefined)
      .map(([source, value]) => `powercfg /set${source}valueindex ${scheme} sub_buttons lidaction ${value}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join('; ');
  });
  const inner = `${commands.join('; ')}; powercfg /setactive scheme_current; exit $LASTEXITCODE`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const command = `$ErrorActionPreference = 'Stop'; $child = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $child.ExitCode`;
  const result = await runProcess('powershell', ['-NoProfile', '-Command', command], 120_000);
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'powercfg lid action write failed');
  for (const { scheme, ac, dc } of actions) {
    const applied = await queryWindowsLidActions(scheme);
    if (!applied || (ac !== undefined && applied.ac !== ac) || (dc !== undefined && applied.dc !== dc)) {
      throw new Error('powercfg lid action was not applied');
    }
  }
}

async function enableWindowsLidSleepPrevention(): Promise<void> {
  const current = await queryWindowsLidActions();
  if (current === undefined) throw new Error('powercfg lid action query failed');
  const backups = getWindowsLidBackups();
  if (Object.keys(backups).length === 0 && (getWindowsLidActionAcOriginal() !== undefined || getWindowsLidActionDcOriginal() !== undefined)) {
    throw new Error('Legacy lid backup has no power scheme; restore the original plan manually');
  }
  const shared = openWindowsLidState();
  shared.migrate(backups);
  shared.claim(current.scheme, { ac: current.ac, dc: current.dc });
  saveWindowsLidBackups({});
  if (current.ac === WINDOWS_LIDACTION_DO_NOTHING && current.dc === WINDOWS_LIDACTION_DO_NOTHING) return;
  await writeWindowsLidActions([{ scheme: current.scheme, ac: WINDOWS_LIDACTION_DO_NOTHING, dc: WINDOWS_LIDACTION_DO_NOTHING }]);
}

async function disableWindowsLidSleepPrevention(): Promise<void> {
  const backups = getWindowsLidBackups();
  const shared = openWindowsLidState();
  shared.migrate(backups);
  if (Object.keys(shared.owned()).length === 0 && getPersistedLidSleep() && !shared.wasReleased()) throw new Error('Original power scheme backup is missing');
  if (Object.keys(backups).length === 0 && (getWindowsLidActionAcOriginal() !== undefined || getWindowsLidActionDcOriginal() !== undefined)) {
    throw new Error('Legacy lid backup has no power scheme; restore the original plan manually');
  }
  const actions: Array<{ scheme: string; ac?: number; dc?: number }> = [];
  let existingSchemes: Set<string> | undefined;
  for (const [scheme, original] of Object.entries(shared.restorable())) {
    const current = await queryWindowsLidActions(scheme);
    if (current === undefined) {
      if (!existingSchemes) {
        const list = await runChecked('powercfg', ['/list']);
        const ids = list.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi);
        if (!ids?.length) throw new Error('powercfg scheme list could not be parsed');
        existingSchemes = new Set(ids.map((id) => id.toLowerCase()));
      }
      if (existingSchemes.has(scheme.toLowerCase())) throw new Error('powercfg lid action query failed');
      continue;
    }
    const ac = current.ac === WINDOWS_LIDACTION_DO_NOTHING && current.ac !== original.ac ? original.ac : undefined;
    const dc = current.dc === WINDOWS_LIDACTION_DO_NOTHING && current.dc !== original.dc ? original.dc : undefined;
    if (ac !== undefined || dc !== undefined) actions.push({ scheme, ac, dc });
  }
  if (actions.length > 0) await writeWindowsLidActions(actions);
  saveWindowsLidBackups({});
  shared.release();
}

async function computeWindowsLidNeedsRepair(): Promise<boolean> {
  const current = await queryWindowsLidActions();
  const owned = openWindowsLidState().owned();
  const backups = { ...getWindowsLidBackups(), ...owned };
  if (current === undefined) return getPersistedLidSleep() || Object.keys(backups).length > 0
    || getWindowsLidActionAcOriginal() !== undefined || getWindowsLidActionDcOriginal() !== undefined;
  if (getPersistedLidSleep()) return !backups[current.scheme] || current.ac !== WINDOWS_LIDACTION_DO_NOTHING || current.dc !== WINDOWS_LIDACTION_DO_NOTHING;
  if (Object.keys(owned).length > 0) return true;
  if (Object.entries(backups).some(([scheme, original]) => scheme !== current.scheme || original.ac !== current.ac || original.dc !== current.dc)) return true;
  const ac = getWindowsLidActionAcOriginal();
  const dc = getWindowsLidActionDcOriginal();
  return (ac !== undefined && current.ac !== ac) || (dc !== undefined && current.dc !== dc);
}

async function probeLinuxInhibit(): Promise<boolean> {
  if (linuxInhibitSupported !== undefined) return linuxInhibitSupported;
  try {
    await runChecked('systemd-inhibit', ['--list', '--no-pager']);
    linuxInhibitSupported = true;
  } catch {
    linuxInhibitSupported = false;
  }
  return linuxInhibitSupported;
}

async function enableLinuxLidSleepPrevention(): Promise<void> {
  if (linuxInhibitStarting !== undefined) return linuxInhibitStarting;
  if (linuxInhibitChild !== undefined) return;
  linuxInhibitStarting = startLinuxLidSleepPrevention();
  try {
    await linuxInhibitStarting;
  } finally {
    linuxInhibitStarting = undefined;
  }
}

async function startLinuxLidSleepPrevention(): Promise<void> {
  const child = spawn(
    'systemd-inhibit',
    ['--what=handle-lid-switch', '--mode=block', '--who=Kimi Code', '--why=Kimi Code 合盖不休眠', 'sh', '-c', 'printf "ready\\n"; read -r lifetime'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  linuxInhibitChild = child;
  child.on('exit', () => {
    if (linuxInhibitChild !== child) return;
    linuxInhibitChild = undefined;
    if (getPersistedLidSleep()) persistLidSleep(false);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => finish(new Error('systemd-inhibit timed out')), LID_SLEEP_HELPER_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelLinuxInhibitStart = undefined;
        child.stdout.off('data', onData);
        if (error) reject(error);
        else resolve();
      };
      const onData = (chunk: Buffer): void => {
        stdout = (stdout + chunk.toString()).slice(-256);
        if (stdout.includes('ready\n')) finish();
      };
      cancelLinuxInhibitStart = () => finish(new Error('systemd-inhibit start cancelled'));
      child.stdout.on('data', onData);
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
      child.once('error', (error) => finish(error));
      child.stdin.on('error', (error) => finish(error));
      child.once('exit', (status) => finish(new Error(stderr.trim() || `systemd-inhibit exited with ${status}`)));
    });
    if (linuxInhibitChild !== child) throw new Error('systemd-inhibit stopped before activation');
  } catch (error) {
    if (linuxInhibitChild === child) linuxInhibitChild = undefined;
    child.stdin.destroy();
    child.kill();
    throw error;
  }
}

function disableLinuxLidSleepPrevention(): void {
  const child = linuxInhibitChild;
  linuxInhibitChild = undefined;
  cancelLinuxInhibitStart?.();
  child?.stdin?.end();
  child?.kill();
}

async function detectLidSupported(): Promise<boolean> {
  if (process.platform === 'darwin') return existsSync(clamshellToolPath());
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return probeLinuxInhibit();
  return false;
}

async function enableLidSleepPrevention(): Promise<void> {
  if (process.platform === 'darwin') return enableMacLidSleepPrevention();
  if (process.platform === 'win32') {
    try {
      await enableWindowsLidSleepPrevention();
    } catch (error) {
      windowsLidNeedsRepair = await computeWindowsLidNeedsRepair().catch(() => true);
      throw error;
    }
    return;
  }
  if (process.platform === 'linux') return enableLinuxLidSleepPrevention();
  throw new Error(`prevent-lid-sleep unsupported on ${process.platform}`);
}

async function disableLidSleepPrevention(): Promise<void> {
  if (process.platform === 'darwin') return disableMacLidSleepPrevention();
  if (process.platform === 'win32') return disableWindowsLidSleepPrevention();
  if (process.platform === 'linux') return disableLinuxLidSleepPrevention();
}

export async function getPreventSleepState(): Promise<PreventSleepState> {
  const lidSupported = await detectLidSupported();
  return {
    system: getPowerSaveBlockerMode(),
    lid: getPersistedLidSleep(),
    lidSupported,
    ...(process.platform === 'win32' && windowsLidNeedsRepair ? { lidNeedsRepair: true } : {}),
  };
}

export function setLidSleepPreventionEnabled(enabled: boolean): Promise<PreventSleepState> {
  if (process.platform !== 'win32') return updateLidSleepPrevention(enabled);
  const operation = windowsLidOperation.then(() => withWindowsLidLock(() => updateLidSleepPrevention(enabled)));
  windowsLidOperation = operation.catch(() => undefined);
  return operation;
}

async function updateLidSleepPrevention(enabled: boolean): Promise<PreventSleepState> {
  if (enabled) {
    if (!(await detectLidSupported())) {
      throw new Error(`prevent-lid-sleep unsupported on ${process.platform}`);
    }
    await enableLidSleepPrevention();
    try {
      savePreventLidSleep(true);
    } catch (error) {
      if (process.platform === 'win32') windowsLidNeedsRepair = true;
      else await disableLidSleepPrevention();
      throw error;
    }
    if (getPowerSaveBlockerMode() === 'allow-sleep') {
      setPowerSaveBlockerMode('prevent-app-suspension');
      persistSystemSleep('prevent-app-suspension');
    }
  } else {
    await disableLidSleepPrevention();
    try {
      savePreventLidSleep(false);
    } catch (error) {
      if (process.platform === 'win32') windowsLidNeedsRepair = true;
      throw error;
    }
  }
  if (process.platform === 'win32') windowsLidNeedsRepair = false;
  return getPreventSleepState();
}

export async function setSystemSleepPreventionEnabled(mode: SleepPreventionMode): Promise<PreventSleepState> {
  if (mode === 'allow-sleep' && getPersistedLidSleep()) {
    await setLidSleepPreventionEnabled(false);
  }
  setPowerSaveBlockerMode(mode);
  persistSystemSleep(mode);
  return getPreventSleepState();
}

export async function applyPreventSleepOnLaunch(): Promise<void> {
  const generation = quitGeneration;
  setPowerSaveBlockerMode(getPersistedSystemSleep());
  const lid = getPersistedLidSleep();
  if (process.platform === 'darwin') {
    if (!lid) return;
    try {
      await enableMacLidSleepPrevention();
    } catch {
      if (generation === quitGeneration) persistLidSleep(false);
    }
    return;
  }
  if (process.platform === 'win32') {
    windowsLidNeedsRepair = await withWindowsLidLock(async () => {
      const backups = getWindowsLidBackups();
      if (Object.keys(backups).length > 0) {
        openWindowsLidState().migrate(backups);
        saveWindowsLidBackups({});
      }
      return computeWindowsLidNeedsRepair();
    }).catch(() => true);
    return;
  }
  if (process.platform === 'linux') {
    if (!lid) return;
    try {
      await enableLinuxLidSleepPrevention();
    } catch {
      if (generation === quitGeneration) persistLidSleep(false);
    }
  }
}

export function restorePreventSleepBeforeQuit(): void {
  quitGeneration++;
  disableMacLidSleepPrevention();
  disableLinuxLidSleepPrevention();
}
