// Auto-update via electron-updater's generic provider.
//
// The packaged app polls latest*.yml at the CDN feed root (the `publish` URL
// in electron-builder.config.cjs, https://code.kimi.com/kimi-code/desktop/).
// The renderer is only a status view: every transition is pushed over the
// `kimi:update-status` bridge event, and the sidebar indicator drives the two
// actions (download → install). By default downloads stay user-initiated;
// opting into `autoDownload` (persisted in ui-state.json, settings →
// advanced) downloads found updates in the background. An already-downloaded
// update still installs silently on a natural quit (`autoInstallOnAppQuit`).
//
// Status surfacing rule: only user-initiated phases (a download the user
// clicked, and its failure) produce visible states beyond `available`.
// Background check failures are logged and swallowed — a laptop on a flaky
// network must not grow an error banner. Background-download failures land in
// `error` too (the download was in flight either way); the renderer hides
// them in auto-download mode and the next scheduled check retries.
//
// The electron-updater instance is injected (`UpdaterLike`) so tests can
// drive the state machine with a fake; `initAutoUpdater()` is the production
// wiring. Everything is a no-op in unpackaged (dev) runs.
//
// Release notes: once a version is known, the matching
// `<version>/changelog.{zh,en}.md` (published next to the artifacts — see the
// release-notes skill and publish-desktop-cdn.sh) is fetched from the same
// CDN root and merged into the pushed status. Older versions simply 404;
// notes are best-effort and never block the update.

import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';

import { IPC } from './ipc-channels';
import { log } from './log';
import { isUpdateAutoDownloadEnabled, setUpdateAutoDownloadEnabled } from './ui-state';
import { markQuitting, sendToRenderer } from './window';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

/** Bilingual release notes for a version (CDN changelog.<lang>.md contents). */
export interface ReleaseNotes {
  zh?: string;
  en?: string;
}

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  /** ISO date from the feed's latest*.yml (the build's release date). */
  releaseDate?: string;
  /** Fetched lazily once a version is known; absent while unfetched/failed. */
  releaseNotes?: ReleaseNotes;
}

/** Result of a user-initiated "check for updates" (settings → advanced). */
export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  /** Dev / unpackaged runs have no updater at all (controller is null). */
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

/** Sentinel `error.message` for a manual check that hit its timeout; display
 *  sites map it to a localized string instead of showing it verbatim. */
export const UPDATE_CHECK_TIMED_OUT = 'update check timed out';

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
  off(event: 'update-downloaded', listener: (info: { version: string; releaseDate?: string }) => void): void;
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
  /** Flip the background-download preference. Enabling starts the download
      immediately when an update is already waiting (available / failed);
      disabling never cancels an in-flight download. */
  setAutoDownload(enabled: boolean): void;
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
  /** Download found updates in the background (default false — opt-in). */
  autoDownload?: boolean;
  /** Fetch the bilingual release notes for a version (production: net.fetch
      against the CDN root; tests inject a fake). Notes are best-effort — the
      implementation never rejects. */
  fetchNotes?: (version: string) => Promise<ReleaseNotes>;
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
    // Release notes belong to a version: carried over while the version
    // stays, dropped as soon as a different version (or none) shows up.
    const keepNotes =
      next.version !== undefined && next.version === current.version ? current.releaseNotes : undefined;
    current = { ...next, releaseNotes: next.releaseNotes ?? keepNotes };
    send(current);
  };

  updater.autoDownload = deps.autoDownload ?? false;
  updater.autoInstallOnAppQuit = true;

  // Changelog fetch: kicked off once a version is known (the first announce,
  // or an already-downloaded update surfacing without a prior announce). One
  // fetch per version; the merge is dropped when the status has moved on to a
  // different version by the time it lands. An empty/failed fetch UNPINS the
  // version so a later event retries — a changelog backfilled after publish
  // (publish-desktop-cdn.sh allows exactly that) must still show up.
  let notesRequestedFor: string | null = null;
  const requestNotes = (version: string): void => {
    if (deps.fetchNotes === undefined || notesRequestedFor === version) {
      return;
    }
    notesRequestedFor = version;
    void deps
      .fetchNotes(version)
      .then((notes) => {
        if (notes.zh === undefined && notes.en === undefined) {
          notesRequestedFor = null;
          return;
        }
        if (current.version === version) {
          setStatus({ ...current, releaseNotes: notes });
        }
      })
      .catch(() => {
        // Best-effort by contract (never rejects); belt and braces — unpin
        // here too so the next event can retry.
        notesRequestedFor = null;
      });
  };

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
    log.info(`[kimi-desktop] update available: ${info.version}`);
    requestNotes(info.version);
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
    log.info(`[kimi-desktop] update downloaded: ${info.version}`);
    // An update downloaded in a previous run surfaces here without a prior
    // 'update-available' — this may be the first time the version is known.
    requestNotes(info.version);
  });
  updater.on('error', (error) => {
    if (current.state === 'downloading') {
      setStatus({ state: 'error', version: current.version, releaseDate: current.releaseDate, message: error.message });
      log.error('[kimi-desktop] update download failed', error);
    } else {
      log.warn(`[kimi-desktop] background update check failed: ${error.message}`);
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

  // User-initiated check: one-shot listeners race the terminal events (plus
  // the promise rejection and a timeout) and resolve with the outcome, so
  // the settings UI can show "latest" / "available" / "failed" inline. A
  // check against an already-downloaded version re-fires 'update-downloaded'
  // instead of 'update-available' — without that listener the check would
  // time out. The persistent listeners above still run — the state machine
  // is updated as usual (a found update still grows the sidebar indicator).
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
        updater.off('update-downloaded', onDownloaded);
        updater.off('error', onError);
        resolve(result);
      };
      const onAvailable = (info: { version: string }): void => finish({ outcome: 'available', version: info.version });
      const onNotAvailable = (): void => finish({ outcome: 'latest' });
      const onDownloaded = (info: { version: string }): void => finish({ outcome: 'available', version: info.version });
      const onError = (error: Error): void => finish({ outcome: 'error', message: error.message });
      const timer = setTimeout(() => finish({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT }), MANUAL_CHECK_TIMEOUT_MS);
      timer.unref();
      updater.on('update-available', onAvailable);
      updater.on('update-not-available', onNotAvailable);
      updater.on('update-downloaded', onDownloaded);
      updater.on('error', onError);
      void updater.checkForUpdates().catch((error: unknown) => {
        finish({ outcome: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    });

  const download = (): void => {
    if (current.state !== 'available' && current.state !== 'error') {
      return;
    }
    setStatus({ state: 'downloading', version: current.version, releaseDate: current.releaseDate, percent: 0 });
    log.info(`[kimi-desktop] update download started: ${current.version ?? 'unknown'}`);
    void updater.downloadUpdate().catch(() => {});
  };

  return {
    getStatus: () => current,
    check: checkNow,
    download,
    install: () => {
      if (current.state !== 'downloaded') {
        return;
      }
      log.info(`[kimi-desktop] installing update ${current.version ?? 'unknown'} (quitAndInstall)`);
      // quitAndInstall emits before-quit only AFTER the window close events,
      // so hide-on-close would intercept those closes and hang the install —
      // mark quitting explicitly first (window.ts).
      markQuitting();
      updater.quitAndInstall(true, true);
    },
    setAutoDownload: (enabled) => {
      updater.autoDownload = enabled;
      // Enabling with a waiting update starts it right away (download()
      // no-ops in every other state); disabling never cancels an in-flight
      // download — it finishes and surfaces as usual.
      if (enabled) {
        download();
      }
    },
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

// --- production singleton -----------------------------------------------------

// Same root as electron-builder.config.cjs's `publish` URL (the update feed);
// release notes live next to the versioned artifacts it points at.
const RELEASE_NOTES_BASE = 'https://code.kimi.com/kimi-code/desktop/';

/** Production fetchNotes: pull `changelog.<lang>.md` from the version's CDN
    directory. Never rejects — a missing/unreachable changelog just means no
    notes, and one language's failure must not take down the other. */
export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const notes: ReleaseNotes = {};
  await Promise.all(
    (['zh', 'en'] as const).map(async (lang) => {
      try {
        const response = await net.fetch(`${RELEASE_NOTES_BASE}${version}/changelog.${lang}.md`);
        if (response.ok) {
          notes[lang] = await response.text();
        }
      } catch {
        // Best-effort: no changelog for this language.
      }
    }),
  );
  return notes;
}

let controller: UpdateController | null = null;

export function initAutoUpdater(): void {
  controller = startAutoUpdater({
    updater: autoUpdater,
    send: (status) => sendToRenderer(IPC.updateStatus, status),
    isPackaged: app.isPackaged,
    autoDownload: isUpdateAutoDownloadEnabled(),
    fetchNotes: fetchReleaseNotes,
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

// The background-download preference is persisted even without a controller
// (dev runs), so the settings UI can read/write it unconditionally.
export function getUpdateAutoDownload(): boolean {
  return isUpdateAutoDownloadEnabled();
}

export function setUpdateAutoDownload(enabled: boolean): void {
  setUpdateAutoDownloadEnabled(enabled);
  controller?.setAutoDownload(enabled);
}
