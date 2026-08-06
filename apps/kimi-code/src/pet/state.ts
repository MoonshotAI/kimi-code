/**
 * Desktop-pet state protocol.
 *
 * The pet overlay (`kimi pet`) runs as a separate process and cannot subscribe
 * to the in-process engine, so running sessions report their status by writing
 * one JSON file per session under `<dataDir>/pet/sessions/`. The overlay polls
 * that directory and renders the aggregate. Liveness is TTL-based, so a
 * crashed CLI process simply stops being reported instead of leaving stale
 * state behind.
 *
 * This module is shared by the reporter (CLI/TUI process) and the overlay
 * (Electron process); keep it free of TUI- or Electron-specific imports.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  getPetOverlayHeartbeatFile,
  getPetOverlayPositionFile,
  getPetSessionsDir,
  getPetSettingsFile,
} from './dirs';

/** How long a session state file stays meaningful without a refresh. */
export const PET_SESSION_TTL_MS = 60_000;
/** A `done` state only wins aggregation for this long before demoting to idle. */
export const PET_DONE_DISPLAY_MS = 15_000;
/** How stale the overlay heartbeat may be before reporters stop writing. */
export const PET_OVERLAY_HEARTBEAT_FRESH_MS = 3_000;

export type PetSessionStatus = 'idle' | 'working' | 'awaiting' | 'done' | 'failed';

export interface PetSessionState {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly status: PetSessionStatus;
  /** Short human-readable summary shown in the pet bubble, e.g. `Bash: ls`. */
  readonly statusText?: string;
  /** The active turn's prompt summary, shown as the bubble title line. */
  readonly title?: string;
  /** CLI process id, so the overlay can signal the session (e.g. SIGINT). */
  readonly pid?: number;
  /** `TERM_PROGRAM` of the CLI process, used to focus its terminal app. */
  readonly termProgram?: string;
  readonly updatedAt: number;
}

export interface PetOverlayHeartbeat {
  readonly pid: number;
  readonly updatedAt: number;
}

export interface PetAggregatedState {
  readonly status: PetSessionStatus;
  readonly statusText?: string;
  readonly title?: string;
  readonly pid?: number;
  readonly termProgram?: string;
  /** Number of live (non-expired) sessions behind the aggregate. */
  readonly sessionCount: number;
}

export interface PetWindowPosition {
  readonly x: number;
  readonly y: number;
}

/** A session entry in the overlay's switchable session list. */
export interface PetSessionSummary {
  readonly sessionId: string;
  readonly status: PetSessionStatus;
  readonly statusText?: string;
  readonly title?: string;
  readonly pid?: number;
  readonly termProgram?: string;
}

/**
 * What the overlay main process sends to the renderer: the top-ranked
 * session's fields (for backwards-compatible display) plus the full ranked
 * list so the user can page through sessions.
 */
export interface PetOverlayState extends PetAggregatedState {
  readonly sessions: readonly PetSessionSummary[];
}

/** Higher number wins when aggregating multiple sessions. */
const STATUS_PRIORITY: Record<PetSessionStatus, number> = {
  idle: 0,
  done: 1,
  working: 2,
  failed: 3,
  awaiting: 4,
};

/**
 * Sort live sessions for display: expired sessions (older than `ttlMs`) are
 * dropped, a `done` state older than `PET_DONE_DISPLAY_MS` demotes to idle,
 * then highest status priority first with ties broken by recency. The
 * overlay shows [0] by default; the rest are reachable by paging.
 */
export function rankSessionStates(
  sessions: readonly PetSessionState[],
  now: number,
  ttlMs: number = PET_SESSION_TTL_MS,
): PetSessionState[] {
  const live: PetSessionState[] = [];
  for (const session of sessions) {
    if (now - session.updatedAt > ttlMs) continue;
    live.push(
      session.status === 'done' && now - session.updatedAt > PET_DONE_DISPLAY_MS
        ? { ...session, status: 'idle', statusText: undefined }
        : session,
    );
  }
  return live.toSorted(
    (a, b) => STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status] || b.updatedAt - a.updatedAt,
  );
}

/**
 * Merge per-session states into the single status the pet should show.
 * Equivalent to the first entry of {@link rankSessionStates}.
 */
export function aggregateSessionStates(
  sessions: readonly PetSessionState[],
  now: number,
  ttlMs: number = PET_SESSION_TTL_MS,
): PetAggregatedState {
  const ranked = rankSessionStates(sessions, now, ttlMs);
  const best = ranked[0];
  if (best === undefined) {
    return { status: 'idle', sessionCount: 0 };
  }
  return {
    status: best.status,
    statusText: best.statusText,
    title: best.title,
    pid: best.pid,
    termProgram: best.termProgram,
    sessionCount: ranked.length,
  };
}

export function petSessionStateFile(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${encodeURIComponent(sessionId)}.json`);
}

/** Atomic JSON write (tmp + rename) so pollers never read a partial file. */
export async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf-8');
  await rename(tmp, file);
}

/** Sync variant of {@link writeJsonFileAtomic} for the in-process reporter. */
export function writeJsonFileAtomicSync(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf-8');
  renameSync(tmp, file);
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/** List all session state files. Never throws — a dirty dir yields []. */
export function readPetSessionStates(sessionsDir: string = getPetSessionsDir()): PetSessionState[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const states: PetSessionState[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(sessionsDir, name), 'utf-8');
      const parsed = JSON.parse(raw) as PetSessionState;
      if (typeof parsed.sessionId === 'string' && typeof parsed.updatedAt === 'number') {
        states.push(parsed);
      }
    } catch {
      // Ignore partially-written or foreign files.
    }
  }
  return states;
}

/**
 * Whether the pet overlay is currently running, from the CLI side. Reporters
 * gate their writes on this so a stopped pet means zero file churn.
 */
export function isPetOverlayAlive(
  heartbeatFile: string = getPetOverlayHeartbeatFile(),
  now: number = Date.now(),
): boolean {
  try {
    const raw = readFileSync(heartbeatFile, 'utf-8');
    const heartbeat = JSON.parse(raw) as PetOverlayHeartbeat;
    if (typeof heartbeat.updatedAt !== 'number') return false;
    if (now - heartbeat.updatedAt > PET_OVERLAY_HEARTBEAT_FRESH_MS) return false;
    process.kill(heartbeat.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePetOverlayHeartbeat(
  heartbeatFile: string = getPetOverlayHeartbeatFile(),
): void {
  mkdirSync(dirname(heartbeatFile), { recursive: true });
  const tmp = `${heartbeatFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }), 'utf-8');
  renameSync(tmp, heartbeatFile);
}

export function readPetWindowPosition(
  file: string = getPetOverlayPositionFile(),
): PetWindowPosition | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PetWindowPosition;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export const PET_SCALE_MIN = 0.5;
export const PET_SCALE_MAX = 2;
export const PET_BUBBLE_FONT_SIZE_MIN = 9;
export const PET_BUBBLE_FONT_SIZE_MAX = 20;
export const PET_BUBBLE_FONT_SIZE_DEFAULT = 13;

export interface PetSettings {
  readonly scale: number;
  /** Bubble title font size in px; the status line is derived from it. */
  readonly bubbleFontSize: number;
}

export const PET_SETTINGS_DEFAULTS: PetSettings = {
  scale: 1,
  bubbleFontSize: PET_BUBBLE_FONT_SIZE_DEFAULT,
};

export function clampPetScale(scale: number): number {
  return Math.min(Math.max(scale, PET_SCALE_MIN), PET_SCALE_MAX);
}

export function clampPetBubbleFontSize(size: number): number {
  return Math.min(Math.max(size, PET_BUBBLE_FONT_SIZE_MIN), PET_BUBBLE_FONT_SIZE_MAX);
}

export function readPetSettings(file: string = getPetSettingsFile()): PetSettings {
  try {
    if (!existsSync(file)) return PET_SETTINGS_DEFAULTS;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      scale?: unknown;
      bubbleFontSize?: unknown;
    };
    return {
      scale:
        typeof parsed.scale === 'number' && !Number.isNaN(parsed.scale)
          ? clampPetScale(parsed.scale)
          : PET_SETTINGS_DEFAULTS.scale,
      bubbleFontSize:
        typeof parsed.bubbleFontSize === 'number' && !Number.isNaN(parsed.bubbleFontSize)
          ? clampPetBubbleFontSize(parsed.bubbleFontSize)
          : PET_SETTINGS_DEFAULTS.bubbleFontSize,
    };
  } catch {
    return PET_SETTINGS_DEFAULTS;
  }
}

/** Merge-write: fields left undefined keep their stored values. */
export function writePetSettings(
  settings: { scale?: number; bubbleFontSize?: number },
  file: string = getPetSettingsFile(),
): void {
  const current = readPetSettings(file);
  writeJsonFileAtomicSync(file, {
    scale: settings.scale === undefined ? current.scale : clampPetScale(settings.scale),
    bubbleFontSize:
      settings.bubbleFontSize === undefined
        ? current.bubbleFontSize
        : clampPetBubbleFontSize(settings.bubbleFontSize),
  });
}

export function writePetWindowPosition(
  position: PetWindowPosition,
  file: string = getPetOverlayPositionFile(),
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(position), 'utf-8');
  renameSync(tmp, file);
}
