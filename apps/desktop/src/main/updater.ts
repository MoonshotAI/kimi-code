// Auto-update via electron-updater's generic provider.
//
// The packaged app polls latest*.yml at the CDN feed root (the `publish` URL
// in electron-builder.config.cjs, https://code.kimi.com/kimi-code/desktop/).
// The renderer is only a status view: every transition is pushed over the
// `kimi:update-status` bridge event, and the sidebar banner drives the two
// actions (download → install). Downloads are user-initiated
// (`autoDownload = false`); an already-downloaded update still installs
// silently on a natural quit (`autoInstallOnAppQuit`).
//
// Status surfacing rule: only user-initiated phases (a download the user
// clicked, and its failure) produce visible states beyond `available`.
// Background check failures are logged and swallowed — a laptop on a flaky
// network must not grow an error banner.
//
// The electron-updater instance is injected (`UpdaterLike`) so tests can
// drive the state machine with a fake; `initAutoUpdater()` is the production
// wiring. Everything is a no-op in unpackaged (dev) runs.

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { IPC } from './ipc-channels';
import { markQuitting, sendToRenderer } from './window';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  /** ISO date from the feed's latest*.yml (the build's release date). */
  releaseDate?: string;
}

/** Result of a user-initiated "check for updates" (settings → advanced). */
export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  /** Dev / unpackaged runs have no updater at all (controller is null). */
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

// Structural subset of electron-updater's AppUpdater (an EventEmitter).
// Declared with method overloads so the real `autoUpdater` stays assignable.
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-available', listener: (info: { version: string; releaseDate?: string }) => void): void;
  on(event: 'update-not-available', listener: () => void): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): void;
  on(event: 'update-downloaded', listener: (info: { version: string; releaseDate?: string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'update-available', listener: (info: { version: string; releaseDate?: string }) => void): void;
  off(event: 'update-not-available', listener: () => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateController {
  getStatus(): UpdateStatus;
  /** User-initiated check (settings → advanced): resolves with the outcome,
      unlike the fire-and-forget scheduled checks. */
  check(): Promise<UpdateCheckResult>;
  download(): void;
  install(): void;
  stop(): void;
}

export interface StartAutoUpdaterDeps {
  updater: UpdaterLike;
  send: (status: UpdateStatus) => void;
  isPackaged: boolean;
  /** Delay before the first check (default 10s — let the window settle). */
  initialDelayMs?: number;
  /** Re-check cadence (default 4h). */
  intervalMs?: number;
}

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// A manual check that never settles (hung request, no error event) must not
// leave the settings row stuck on "checking…" forever.
const MANUAL_CHECK_TIMEOUT_MS = 30_000;

export function startAutoUpdater(deps: StartAutoUpdaterDeps): UpdateController | null {
  if (!deps.isPackaged) {
    return null;
  }
  const { updater, send } = deps;

  let current: UpdateStatus = { state: 'idle' };
  const setStatus = (next: UpdateStatus): void => {
    current = next;
    send(current);
  };

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;

  updater.on('update-available', (info) => {
    // A scheduled re-check can re-announce the version the user already has
    // in flight; never regress downloading/downloaded back to available —
    // the "Restart Now" action must survive until it is used.
    if (
      (current.state === 'downloading' || current.state === 'downloaded') &&
      current.version === info.version
    ) {
      return;
    }
    setStatus({ state: 'available', version: info.version, releaseDate: info.releaseDate });
  });
  updater.on('update-not-available', () => {
    // The feed no longer offers anything newer (e.g. the CDN pointer was
    // rolled back): drop the stale `available` / `error` states — a retry
    // against a pulled version would just fail again. In-flight downloads /
    // installs are left alone: they finish or fail on their own events.
    if (current.state === 'available' || current.state === 'error') {
      setStatus({ state: 'idle' });
    }
  });
  updater.on('download-progress', (progress) => {
    setStatus({
      state: 'downloading',
      version: current.version,
      releaseDate: current.releaseDate,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  });
  updater.on('update-downloaded', (info) => {
    setStatus({ state: 'downloaded', version: info.version, releaseDate: info.releaseDate });
  });
  updater.on('error', (error) => {
    if (current.state === 'downloading') {
      setStatus({ state: 'error', version: current.version, releaseDate: current.releaseDate, message: error.message });
    } else {
      console.warn('[updater] background check failed:', error.message);
    }
  });

  const check = (): void => {
    // electron-updater reports failures through BOTH the returned promise and
    // the 'error' event; the event handles state, so swallow the rejection.
    void updater.checkForUpdates().catch(() => {});
  };
  const initialTimer = setTimeout(check, deps.initialDelayMs ?? INITIAL_DELAY_MS);
  const intervalTimer = setInterval(check, deps.intervalMs ?? CHECK_INTERVAL_MS);
  initialTimer.unref();
  intervalTimer.unref();

  // User-initiated check: one-shot listeners race the three terminal events
  // (plus the promise rejection and a timeout) and resolve with the outcome,
  // so the settings UI can show "latest" / "available" / "failed" inline.
  // The persistent listeners above still run — the state machine is updated
  // as usual (a found update still grows the sidebar indicator).
  const checkNow = (): Promise<UpdateCheckResult> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: UpdateCheckResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        updater.off('update-available', onAvailable);
        updater.off('update-not-available', onNotAvailable);
        updater.off('error', onError);
        resolve(result);
      };
      const onAvailable = (info: { version: string }): void => finish({ outcome: 'available', version: info.version });
      const onNotAvailable = (): void => finish({ outcome: 'latest' });
      const onError = (error: Error): void => finish({ outcome: 'error', message: error.message });
      const timer = setTimeout(() => finish({ outcome: 'error', message: 'check timed out' }), MANUAL_CHECK_TIMEOUT_MS);
      timer.unref();
      updater.on('update-available', onAvailable);
      updater.on('update-not-available', onNotAvailable);
      updater.on('error', onError);
      void updater.checkForUpdates().catch((error: unknown) => {
        finish({ outcome: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    });

  return {
    getStatus: () => current,
    check: checkNow,
    download: () => {
      if (current.state !== 'available' && current.state !== 'error') {
        return;
      }
      setStatus({ state: 'downloading', version: current.version, releaseDate: current.releaseDate, percent: 0 });
      void updater.downloadUpdate().catch(() => {});
    },
    install: () => {
      if (current.state !== 'downloaded') {
        return;
      }
      // quitAndInstall emits before-quit only AFTER the window close events,
      // so hide-on-close would intercept those closes and hang the install —
      // mark quitting explicitly first (window.ts).
      markQuitting();
      updater.quitAndInstall(true, true);
    },
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

// --- production singleton -----------------------------------------------------

let controller: UpdateController | null = null;

export function initAutoUpdater(): void {
  controller = startAutoUpdater({
    updater: autoUpdater,
    send: (status) => sendToRenderer(IPC.updateStatus, status),
    isPackaged: app.isPackaged,
  });
}

// IPC entry points (see ipc.ts). All safe to call before initAutoUpdater ran
// or in dev (controller === null): they degrade to idle / no-ops.
export function getUpdateStatus(): UpdateStatus {
  return controller?.getStatus() ?? { state: 'idle' };
}

export function requestUpdateCheck(): Promise<UpdateCheckResult> {
  return controller?.check() ?? Promise.resolve({ outcome: 'unsupported' });
}

export function requestUpdateDownload(): void {
  controller?.download();
}

export function requestUpdateInstall(): void {
  controller?.install();
}
