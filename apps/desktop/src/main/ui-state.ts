// Renderer UI flags persisted by the main process (onboarding completion for
// now). Renderer localStorage is origin-scoped — the Vite dev server's
// shifting port (strictPort: false) would keep resetting it — so durable
// flags live in <userData>/ui-state.json instead, shared by dev and packaged
// builds (same userData dir). Mirrors the window-state.json / pet-state.json
// pattern; functions take an optional file path for tests.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

export interface UiState {
  onboarded?: boolean;
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
  try {
    const next = { ...loadUiState(file), onboarded: true };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next));
  } catch {
    // Best-effort; losing the flag only re-shows the wizard once.
  }
}
