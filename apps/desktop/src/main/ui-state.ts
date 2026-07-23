// Renderer UI flags persisted by the main process (onboarding completion, the
// auto-update download preference). Renderer localStorage is origin-scoped —
// the Vite dev server's shifting port (strictPort: false) would keep resetting
// it — so durable flags live in <userData>/ui-state.json instead, shared by
// dev and packaged builds (same userData dir). Mirrors the window-state.json /
// pet-state.json pattern; functions take an optional file path for tests.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

export interface UiState {
  onboarded?: boolean;
  /** Auto-download updates in the background (updater.ts). Absent = disabled
      (opt-in via settings → advanced). */
  updateAutoDownload?: boolean;
}

function defaultStateFile(): string {
  return join(app.getPath('userData'), 'ui-state.json');
}

export function loadUiState(file: string = defaultStateFile()): UiState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<UiState>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    // No saved state yet, or it is unreadable — fall back to empty.
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

function writeUiState(patch: Partial<UiState>, file: string): void {
  try {
    const next = { ...loadUiState(file), ...patch };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next));
  } catch {
    // Best-effort; losing a flag only re-shows the wizard once / falls back
    // to the default update behavior.
  }
}
