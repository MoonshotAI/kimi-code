import { isBrowserSearchEngine, type BrowserSearchEngine } from '../../shared/browser-search';
import { isSleepPreventionMode, type SleepPreventionMode } from '../../shared/prevent-sleep';
import type { BrowserDownloadsAccess, BrowserPreferences } from '../../shared/browser-data';
import { isBrowserAutoplay, type BrowserAutoplay } from '../../shared/browser-autoplay';
import { isBrowserSound, type BrowserSound } from '../../shared/browser-sound';
import { browserUserAgentSavedPresetsFrom, isBrowserCustomUserAgent, type BrowserUserAgentSavedPreset } from '../../shared/browser-user-agent';

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { app } from 'electron';
import type { ColorScheme } from '../ipc/ipc-channels';
import { asBrowserDownloadEntry, asBrowserHistoryEntry, type BrowserDownloadRecord } from '../../shared/browser-data-records';
import type { BrowserHistoryEntry } from '../../shared/browser-data';

const BROWSER_HISTORY_BYTES_MAX = 384 * 1_024;
const BROWSER_DOWNLOAD_BYTES_MAX = 128 * 1_024;

export interface PendingSessionContinue {
  sessionIds: string[];
  armedAt: number;
  fromVersion: string;
}

export interface UiState {
  onboarded?: boolean;
  vibrancy?: boolean;
  preventSystemSleep?: boolean | SleepPreventionMode;
  preventLidSleep?: boolean;
  windowsLidActionAcOriginal?: number;
  windowsLidActionDcOriginal?: number;
  windowsLidBackups?: Record<string, { ac: number; dc: number }>;
  windowsLidBackupRecoveryRequired?: boolean;
  dockIconChoice?: 'light' | 'dark';
  colorScheme?: ColorScheme;
  updateAutoDownload?: boolean;
  remoteControlRestoreEnabled?: boolean;
  remoteControlPreviousEnabled?: boolean;
  firstLaunchReported?: boolean;
  pendingSessionContinue?: PendingSessionContinue;
  browserAgentControl?: boolean;
  browserSubagentControl?: boolean;
  browserAgentLocalFiles?: boolean;
  linuxNativeTitleBar?: boolean;
  browserAskWhereToSave?: boolean;
  browserDefaultZoomFactor?: number;
  browserCustomUserAgent?: string | null;
  browserUserAgentPresets?: BrowserUserAgentSavedPreset[];
  browserSearchEngine?: BrowserSearchEngine;
  browserAutoplay?: BrowserAutoplay;
  browserSound?: BrowserSound;
  browserAgentDownloadDirectory?: string;
  browserAgentDownloadLimitBytes?: number | null;
  browserDownloadsAccess?: 'granted' | 'denied';
  localNetworkPermissionProbed?: boolean;
  browserHistory?: BrowserHistoryEntry[];
  browserDownloads?: BrowserDownloadRecord[];
}

export function getBrowserPreferences(file?: string): BrowserPreferences {
  const state = loadUiState(file);
  const zoom = state.browserDefaultZoomFactor;
  const directory = state.browserAgentDownloadDirectory;
  const limit = state.browserAgentDownloadLimitBytes;
  return {
    agentControl: state.browserAgentControl !== false,
    subagentControl: state.browserSubagentControl === true,
    agentLocalFiles: state.browserAgentLocalFiles === true,
    searchEngine: isBrowserSearchEngine(state.browserSearchEngine) ? state.browserSearchEngine : 'google',
    autoplay: isBrowserAutoplay(state.browserAutoplay) ? state.browserAutoplay : 'block',
    sound: isBrowserSound(state.browserSound) ? state.browserSound : 'muted',
    askWhereToSave: state.browserAskWhereToSave !== false,
    defaultZoomFactor:
      typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= 0.5 && zoom <= 2 ? zoom : 1,
    customUserAgent: isBrowserCustomUserAgent(state.browserCustomUserAgent) ? state.browserCustomUserAgent : null,
    userAgentPresets: browserUserAgentSavedPresetsFrom(state.browserUserAgentPresets),
    ...(typeof directory === 'string' && directory.length > 0 && directory.length <= 4096 ? { agentDownloadDirectory: directory } : {}),
    ...(limit === null || (Number.isSafeInteger(limit) && limit! > 0) ? { agentDownloadLimitBytes: limit } : {}),
  };
}

export function getBrowserDownloadsAccess(file?: string): BrowserDownloadsAccess {
  const access = loadUiState(file).browserDownloadsAccess;
  return access === 'granted' || access === 'denied' ? access : 'unknown';
}

export function saveBrowserDownloadsAccess(access: 'granted' | 'denied', file: string = defaultStateFile()): void {
  writeUiState({ browserDownloadsAccess: access }, file);
}

export function saveBrowserPreferences(
  preferences: BrowserPreferences,
  file: string = defaultStateFile(),
): void {
  writeUiState(
    {
      browserAgentControl: preferences.agentControl,
      browserSubagentControl: preferences.subagentControl,
      browserAgentLocalFiles: preferences.agentLocalFiles,
      browserSearchEngine: preferences.searchEngine,
      browserAutoplay: preferences.autoplay,
      browserSound: preferences.sound,
      browserAskWhereToSave: preferences.askWhereToSave,
      browserDefaultZoomFactor: preferences.defaultZoomFactor,
      browserCustomUserAgent: preferences.customUserAgent,
      browserUserAgentPresets: preferences.userAgentPresets,
      browserAgentDownloadDirectory: preferences.agentDownloadDirectory,
      browserAgentDownloadLimitBytes: preferences.agentDownloadLimitBytes,
    },
    file,
  );
}

export function getBrowserRecords(file?: string): {
  history: BrowserHistoryEntry[];
  downloads: BrowserDownloadRecord[];
} {
  const state = loadUiState(file);
  const history = Array.isArray(state.browserHistory)
    ? boundedBrowserRecords(state.browserHistory, 200, BROWSER_HISTORY_BYTES_MAX, asBrowserHistoryEntry)
    : [];
  const downloads = Array.isArray(state.browserDownloads)
    ? boundedBrowserRecords(state.browserDownloads, 100, BROWSER_DOWNLOAD_BYTES_MAX, asBrowserDownloadEntry)
    : [];
  return { history, downloads };
}

export function saveBrowserRecords(
  records: { history: BrowserHistoryEntry[]; downloads: BrowserDownloadRecord[] },
  file: string = defaultStateFile(),
): void {
  writeUiState(
    {
      browserHistory: boundedBrowserRecords(
        records.history,
        200,
        BROWSER_HISTORY_BYTES_MAX,
        asBrowserHistoryEntry,
      ),
      browserDownloads: boundedBrowserRecords(
        records.downloads,
        100,
        BROWSER_DOWNLOAD_BYTES_MAX,
        asBrowserDownloadEntry,
      ),
    },
    file,
  );
}

function boundedBrowserRecords<T>(
  values: readonly unknown[],
  limit: number,
  maxBytes: number,
  parse: (value: unknown) => T | null,
): T[] {
  const records: T[] = [];
  let bytes = 2;
  for (const value of values) {
    if (records.length >= limit) break;
    const record = parse(value);
    if (record === null) continue;
    const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
    if (bytes + recordBytes > maxBytes) break;
    records.push(record);
    bytes += recordBytes;
  }
  return records;
}

function defaultStateFile(): string {
  return join(app.getPath('userData'), 'ui-state.json');
}

export function loadUiState(file: string = defaultStateFile()): UiState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<UiState>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function isOnboarded(file?: string): boolean {
  return loadUiState(file).onboarded === true;
}

export function markOnboarded(file: string = defaultStateFile()): void {
  writeUiState({ onboarded: true }, file);
}

export function isUpdateAutoDownloadEnabled(file?: string): boolean {
  return loadUiState(file).updateAutoDownload === true;
}

export function setUpdateAutoDownloadEnabled(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ updateAutoDownload: enabled }, file);
}

export interface RemoteControlRestoreState {
  restoreEnabled: boolean;
  previousEnabled: boolean;
}

export function getRemoteControlRestoreState(file?: string): RemoteControlRestoreState {
  const state = loadUiState(file);
  return {
    restoreEnabled: state.remoteControlRestoreEnabled === true,
    previousEnabled: state.remoteControlPreviousEnabled === true,
  };
}

export function setRemoteControlRestoreEnabled(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ remoteControlRestoreEnabled: enabled }, file);
}

export function setRemoteControlPreviousEnabled(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ remoteControlPreviousEnabled: enabled }, file);
}

function writeUiState(patch: Partial<UiState>, file: string): void {
  try {
    writeUiStateRecovering(patch, file);
  } catch {}
}

function writeUiStateRecovering(patch: Partial<UiState>, file: string): void {
  try {
    writeUiStateStrict(patch, file);
  } catch (error) {
    if (!(error instanceof InvalidUiStateError)) throw error;
    copyFileSync(file, `${file}.corrupt-${randomUUID()}`);
    writeUiStateValue({ ...patch, windowsLidBackupRecoveryRequired: true }, file);
  }
}

export function isVibrancyEnabled(file?: string): boolean {
  return loadUiState(file).vibrancy !== false;
}

export function getColorScheme(file?: string): ColorScheme {
  const value = loadUiState(file).colorScheme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function setColorScheme(scheme: ColorScheme, file: string = defaultStateFile()): void {
  if (getColorScheme(file) === scheme) return;
  writeUiState({ colorScheme: scheme }, file);
}

export function setVibrancyEnabled(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ vibrancy: enabled }, file);
}

export function getPreventSystemSleep(file?: string): SleepPreventionMode {
  const value = loadUiState(file).preventSystemSleep;
  if (isSleepPreventionMode(value)) return value;
  return value === true ? 'prevent-app-suspension' : 'allow-sleep';
}

export function setPreventSystemSleep(mode: SleepPreventionMode, file: string = defaultStateFile()): void {
  writeUiState({ preventSystemSleep: mode }, file);
}

export function getLocalNetworkPermissionProbed(file?: string): boolean {
  return loadUiState(file).localNetworkPermissionProbed === true;
}

export function setLocalNetworkPermissionProbed(probed: boolean, file: string = defaultStateFile()): void {
  writeUiState({ localNetworkPermissionProbed: probed }, file);
}

export function getPreventLidSleep(file?: string): boolean {
  return loadUiState(file).preventLidSleep === true;
}

export function setPreventLidSleep(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ preventLidSleep: enabled }, file);
}

export function savePreventLidSleep(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiStateStrict({ preventLidSleep: enabled }, file);
  if (loadUiStateStrict(file).preventLidSleep !== enabled) throw new Error('Lid sleep preference was not saved');
}

export function getWindowsLidActionAcOriginal(file?: string): number | undefined {
  const value = loadUiState(file).windowsLidActionAcOriginal;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3 ? value : undefined;
}

export function setWindowsLidActionAcOriginal(value: number | undefined, file: string = defaultStateFile()): void {
  writeUiState({ windowsLidActionAcOriginal: value }, file);
}

export function getWindowsLidActionDcOriginal(file?: string): number | undefined {
  const value = loadUiState(file).windowsLidActionDcOriginal;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : undefined;
}

export function setWindowsLidActionDcOriginal(value: number | undefined, file: string = defaultStateFile()): void {
  writeUiState({ windowsLidActionDcOriginal: value }, file);
}

export function getWindowsLidBackups(file?: string): Record<string, { ac: number; dc: number }> {
  const state = loadUiStateStrict(file ?? defaultStateFile());
  if (state.windowsLidBackupRecoveryRequired) throw new Error('Power scheme backups require recovery from the saved corrupt state file');
  const backups = state.windowsLidBackups ?? {};
  if (typeof backups !== 'object' || Array.isArray(backups) || Object.entries(backups).some(([scheme, value]) =>
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scheme)
    || !value || ![value.ac, value.dc].every((action) => Number.isInteger(action) && action >= 0 && action <= 3))) {
    throw new Error('Invalid power scheme backups');
  }
  return backups;
}

export function saveWindowsLidBackups(backups: Record<string, { ac: number; dc: number }>, file: string = defaultStateFile()): void {
  getWindowsLidBackups(file);
  writeUiStateStrict({ windowsLidBackups: backups, windowsLidActionAcOriginal: undefined, windowsLidActionDcOriginal: undefined }, file);
}

class InvalidUiStateError extends Error {}

function loadUiStateStrict(file: string): UiState {
  try {
    const content = readFileSync(file, 'utf8');
    let state: UiState;
    try {
      state = JSON.parse(content) as UiState;
    } catch {
      throw new InvalidUiStateError('Invalid UI state');
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new InvalidUiStateError('Invalid UI state');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
}

function writeUiStateStrict(patch: Partial<UiState>, file: string): void {
  const next = { ...loadUiStateStrict(file), ...patch };
  writeUiStateValue(next, file);
}

function writeUiStateValue(next: UiState, file: string): void {
  const temporary = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(next), { flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function isLinuxNativeTitleBar(file?: string): boolean {
  return loadUiState(file).linuxNativeTitleBar === true;
}

export function setLinuxNativeTitleBar(enabled: boolean, file: string = defaultStateFile()): void {
  writeUiState({ linuxNativeTitleBar: enabled }, file);
}

export function getDockIconChoice(file?: string): 'light' | 'dark' | undefined {
  const value = loadUiState(file).dockIconChoice;
  return value === 'light' || value === 'dark' ? value : undefined;
}

export function saveDockIconChoice(choice: 'light' | 'dark', file: string = defaultStateFile()): void {
  writeUiState({ dockIconChoice: choice }, file);
}

export function shouldReportFirstLaunch(file: string = defaultStateFile()): boolean {
  return loadUiState(file).firstLaunchReported !== true;
}

export function markFirstLaunchReported(file: string = defaultStateFile()): void {
  writeUiState({ firstLaunchReported: true }, file);
}

export function savePendingSessionContinue(
  pending: PendingSessionContinue | undefined,
  file: string = defaultStateFile(),
): void {
  writeUiStateRecovering({ pendingSessionContinue: pending }, file);
}

export function takePendingSessionContinue(file: string = defaultStateFile()): PendingSessionContinue | undefined {
  const value: unknown = loadUiState(file).pendingSessionContinue;
  if (value === undefined) return undefined;
  writeUiState({ pendingSessionContinue: undefined }, file);
  if (value === null || typeof value !== 'object') return undefined;
  const { sessionIds, armedAt, fromVersion } = value as Record<string, unknown>;
  if (!Array.isArray(sessionIds) || typeof fromVersion !== 'string') return undefined;
  if (typeof armedAt !== 'number' || !Number.isFinite(armedAt)) return undefined;
  return {
    sessionIds: sessionIds.filter((id): id is string => typeof id === 'string' && id !== ''),
    armedAt,
    fromVersion,
  };
}
