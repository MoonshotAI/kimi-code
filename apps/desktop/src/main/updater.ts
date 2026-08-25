// Auto-update via electron-updater's generic provider.
//
// The packaged app polls latest*.yml at the CDN feed root (the `publish` URL
// in electron-builder.config.cjs, https://code.kimi.com/kimi-code/desktop/).
// The feed root follows the server-resolved account region (region.ts): the
// baked-in .com URL is only the default until `GET /oauth/region` resolves,
// re-applied via `autoUpdater.setFeedURL` before every check.
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
// `error` too (the download was in flight either way) and surfaces like any
// other failure — the renderer shows it with a retry path; the next
// scheduled check retries on its own.
//
// The electron-updater instance is injected (`UpdaterLike`) so tests can
// drive the state machine with a fake; `initAutoUpdater()` is the production
// wiring. Everything is a no-op in unpackaged (dev) runs.
//
// Release notes: once a version is known, the matching
// `binaries/<version>/changelog.{zh,en}.md` (published next to the artifacts — see the
// release-notes skill and publish-desktop-cdn.sh) is fetched from the same
// CDN root and merged into the pushed status. Older versions simply 404;
// notes are best-effort and never block the update.

import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';

import { IPC } from './ipc-channels';
import { log } from './log';
import { isCanaryVersion } from './release-channel';
import { refreshServerRegion, serverRegionProfile, whenServerRegionSource } from './region';
import { isUpdateAutoDownloadEnabled, setUpdateAutoDownloadEnabled } from './ui-state';
import { markQuitting, sendToRenderer } from './window';
import { trackDesktopEvent } from './track';

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
  /** Repoint the generic feed (region switching); absent on minimal fakes.
      channel must be carried along on every call — see updateChannelFromVersion. */
  setFeedURL?(options: { provider: 'generic'; url: string; channel?: string }): void;
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
  /** Flip the background-download preference. Applies to future checks
      only — a waiting update still downloads on the user's click, and
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
  /** Resolve the current feed URL (production: refresh the server region,
      then derive the region's CDN root). Called before every check; a
      rejection or absence keeps the previously applied feed — initially the
      cn default baked into app-update.yml. */
  resolveFeedUrl?: () => Promise<string>;
  /** Update channel passed along on every setFeedURL (production: derived
      from the app version — updateChannelFromVersion). Default 'latest'. */
  updateChannel?: string;
}

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// A manual check that never settles (hung request, no error event) must not
// leave the settings row stuck on "checking…" forever.
const MANUAL_CHECK_TIMEOUT_MS = 30_000;
// Chain-level bound for one underlying check: a check that never settles must
// not park every later check behind it (the manual UI timeout alone only
// rescues the waiter, not the queue). Deliberately above the manual timeout.
const CHECK_CHAIN_TIMEOUT_MS = 60_000;

/** The update channel of this build, derived with the same rule electron-
 *  builder's detectUpdateChannel applies at build time (prerelease segment
 *  of the version: 0.0.x-alpha.N → 'alpha'; stable → 'latest').
 *  Must be passed on every setFeedURL: that call REPLACES the whole provider
 *  configuration — including the channel baked into app-update.yml — so a
 *  prerelease build would otherwise fall back to polling latest*.yml. (Not
 *  autoUpdater.channel = …: that setter also force-enables allowDowngrade.) */
export function updateChannelFromVersion(version: string): string {
  const tag = version.split('-')[1]?.split('.')[0];
  return tag === undefined || tag === '' ? 'latest' : tag;
}

export function startAutoUpdater(deps: StartAutoUpdaterDeps): UpdateController | null {
  if (!deps.isPackaged) {
    return null;
  }
  const { updater, send } = deps;

  let current: UpdateStatus = { state: 'idle' };
  const setStatus = (next: UpdateStatus, errorClass?: string): void => {
    const previousState = current.state;
    // Release notes belong to a version: carried over while the version
    // stays, dropped as soon as a different version (or none) shows up.
    const keepNotes =
      next.version !== undefined && next.version === current.version ? current.releaseNotes : undefined;
    current = { ...next, releaseNotes: next.releaseNotes ?? keepNotes };
    send(current);
    // State transitions only — download-progress re-enters `downloading` per
    // chunk and would drown the stream.
    if (current.state !== previousState) {
      trackDesktopEvent('update_status_changed', {
        state: current.state,
        from_version: app.getVersion(),
        to_version: current.version,
        prev_state: previousState,
        ...(current.state === 'error' && errorClass !== undefined ? { error_class: errorClass } : {}),
      });
    }
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
      setStatus(
        { state: 'error', version: current.version, releaseDate: current.releaseDate, message: error.message },
        error.name,
      );
      log.error('[kimi-desktop] update download failed', error);
    } else {
      log.warn(`[kimi-desktop] background update check failed: ${error.message}`);
    }
  });

  // Feed resolution: the update feed follows the server-resolved region
  // (region.ts). Re-resolved before every check — the region can change with
  // login/logout and the main process has no login-event hook; the check
  // cadence (startup +10s, then 4h, plus manual checks) bounds staleness.
  // Any failure keeps the previously applied feed (initially the cn default
  // baked into app-update.yml). Unconfigured (tests, minimal fakes) = the
  // baked-in feed stays, and checks take the synchronous path they always
  // had.
  const resolveFeed = deps.resolveFeedUrl;
  const setFeed = updater.setFeedURL?.bind(updater);
  const canSwitchFeed = resolveFeed !== undefined && setFeed !== undefined;
  const updateChannel = deps.updateChannel ?? 'latest';
  let appliedFeedUrl: string | undefined;
  const applyFeedUrl = async (): Promise<void> => {
    if (!canSwitchFeed) {
      return;
    }
    try {
      const url = await resolveFeed();
      if (url !== appliedFeedUrl) {
        // channel 必须随 setFeedURL 一起给——它会整体替换 provider 配置，
        // 不带 channel 预发版会退回轮询 latest*.yml（见 updateChannelFromVersion）。
        setFeed({ provider: 'generic', url, channel: updateChannel });
        appliedFeedUrl = url;
      }
    } catch {
      // Keep the previously applied (or baked-in) feed.
    }
  };

  // A stopped controller suppresses every fire-and-forget continuation that
  // can outlive stop(): the late-source follow-up below, and a whenFeedReady
  // continuation still awaiting when the timers were cleared.
  let stopped = false;
  // Armed the first time a round's source-wait bound expires: ONE unbounded
  // follow-up that re-checks with the right feed the moment the source
  // actually lands. Arming per round would stack one waiter — and one
  // eventual back-to-back re-check — per expired round.
  let lateRecheckArmed = false;
  const armLateRecheck = (): void => {
    if (lateRecheckArmed) {
      return;
    }
    lateRecheckArmed = true;
    void whenServerRegionSource(Infinity).then(() => {
      if (stopped) {
        return;
      }
      void applyFeedUrl().then(() => {
        if (stopped) {
          return;
        }
        void runCheckSerialized().catch(() => {});
      });
    });
  };
  // A check only makes sense once the region source exists — without it the
  // refresh answers the default region and a global user would be pointed at
  // the mainland feed. Slow starts (packaged app, first-connect retries)
  // reach this before connect.ts records the source, so wait it out. If the
  // bound still expires (a very slow embedded start, or a first start that
  // only succeeds after the user retries from the menu), run this round on
  // the baked-in feed but re-check once the source lands — an update must not
  // stay hidden until the 4h interval for the user who needs it most.
  const whenFeedReady = async (): Promise<void> => {
    const ready = await whenServerRegionSource();
    if (!ready) {
      // The bound expired: this round runs on the baked-in feed.
      armLateRecheck();
    }
    await applyFeedUrl();
  };

  // Checks serialize through this chain. A scheduled tick and a manual check
  // must never run checkForUpdates concurrently: electron-updater's outcome
  // events carry no correlation, so a manual waiter listening during a
  // scheduled check would settle with the scheduled check's result. The chain
  // link itself never rejects, so a queued check always runs; each caller
  // still observes its own rejection through the returned promise.
  let checkChain: Promise<unknown> = Promise.resolve();
  // The raw attempt of the latest check, tracked past its chain link. When
  // the link's race releases the queue, the attempt underneath may still be
  // alive, and electron-updater offers no way to cancel it. Its outcome
  // events carry no request identity, so the next round must wait it out
  // (bounded) instead of overlapping — a late event from the old attempt
  // would otherwise settle the next check's listeners with an outcome that
  // is not their own. A still-wedged attempt makes the round SKIP, so the
  // queue keeps advancing without two checks ever being in flight together.
  let pendingAttempt: Promise<unknown> | null = null;
  const runCheckSerialized = (onStart?: () => boolean): Promise<unknown> => {
    const result = checkChain.then(async () => {
      if (pendingAttempt !== null) {
        const settled = await Promise.race([
          pendingAttempt.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => {
            setTimeout(() => resolve(false), CHECK_CHAIN_TIMEOUT_MS);
          }),
        ]);
        if (!settled) {
          log.warn('[kimi-desktop] previous update check still hung — skipping this round');
          return undefined;
        }
        // electron-updater emits its outcome events around promise
        // settlement; yield a macrotask so those events land before this
        // round's listeners attach (onStart runs after this).
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      // onStart may veto the run (e.g. the manual waiter timed out while
      // queued) — attaching listeners or starting then would strand state.
      if (onStart?.() === false) return undefined;
      const attempt = updater.checkForUpdates();
      pendingAttempt = attempt;
      const release = (): void => {
        if (pendingAttempt === attempt) {
          pendingAttempt = null;
        }
      };
      void attempt.then(release, release);
      // A hung checkForUpdates must not park the chain behind it: the race
      // releases the queue after a bound, while pendingAttempt keeps
      // tracking real settlement for the next round's gate.
      return Promise.race([
        attempt,
        new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), CHECK_CHAIN_TIMEOUT_MS);
        }),
      ]);
    });
    checkChain = result.catch(() => {});
    return result;
  };

  const check = (): void => {
    // electron-updater reports failures through BOTH the returned promise and
    // the 'error' event; the event handles state, so swallow the rejection.
    if (stopped) {
      return;
    }
    if (!canSwitchFeed) {
      void runCheckSerialized().catch(() => {});
      return;
    }
    void whenFeedReady().then(() => {
      if (stopped) {
        return;
      }
      void runCheckSerialized().catch(() => {});
    });
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
      // Listeners attach only when this check actually starts (onStart) —
      // attaching earlier would let a concurrently running scheduled check's
      // events settle the manual request with the wrong outcome (checks are
      // serialized, so nothing else is in flight at onStart).
      const attachAndRun = (): void => {
        updater.on('update-available', onAvailable);
        updater.on('update-not-available', onNotAvailable);
        updater.on('update-downloaded', onDownloaded);
        updater.on('error', onError);
      };
      const onCheckRejected = (error: unknown): void => {
        finish({ outcome: 'error', message: error instanceof Error ? error.message : String(error) });
      };
      const timer = setTimeout(() => finish({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT }), MANUAL_CHECK_TIMEOUT_MS);
      timer.unref();
      if (!canSwitchFeed) {
        void runCheckSerialized(() => {
          if (settled) return false;
          attachAndRun();
          return true;
        }).catch(onCheckRejected);
      } else {
        void whenFeedReady().then(() => {
          // The manual timeout may have settled the promise while the feed
          // was still pending — starting now would run a check nobody is
          // listening to and strand four listeners finish() can no longer
          // remove. The same veto lives in onStart for the queued case.
          if (settled) return;
          void runCheckSerialized(() => {
            if (settled) return false;
            attachAndRun();
            return true;
          }).catch(onCheckRejected);
        });
      }
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
      // A pure preference: only FUTURE checks auto-start their downloads
      // (electron-updater's flag applies on the next checkForUpdates). A
      // currently waiting update still requires the user's click, so the
      // dialog checkbox / settings toggle never close the dialog or hide
      // the pill as a side effect; disabling never cancels an in-flight
      // download either — it finishes and surfaces as usual.
      updater.autoDownload = enabled;
    },
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

// --- production singleton -----------------------------------------------------

// Release notes live next to the versioned artifacts on the CDN root that
// electron-builder.config.cjs's `publish` URL seeds; like the update feed,
// the root follows the server-resolved region (region.ts), defaulting to the
// cn host until a region refresh lands.
function releaseNotesBase(): string {
  return `${serverRegionProfile().cdnBase}/desktop/`;
}

/** Production fetchNotes: pull `changelog.<lang>.md` from the version's CDN
    directory. Never rejects — a missing/unreachable changelog just means no
    notes, and one language's failure must not take down the other. */
export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const notes: ReleaseNotes = {};
  await Promise.all(
    (['zh', 'en'] as const).map(async (lang) => {
      try {
        const response = await net.fetch(`${releaseNotesBase()}binaries/${version}/changelog.${lang}.md`);
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
  // Canary 构建禁用 CDN 自动更新：stable 的 latest*.yml 指针版本在 semver
  // 上大于 x.y.z-canary.n，不禁用会把 canary「更新」回正式版（甚至退出时
  // 静默替换）。canary 的更新走 canary.ts 的 gh 通道。
  if (isCanaryVersion(app.getVersion())) {
    return;
  }
  controller = startAutoUpdater({
    updater: autoUpdater,
    send: (status) => sendToRenderer(IPC.updateStatus, status),
    isPackaged: app.isPackaged,
    autoDownload: isUpdateAutoDownloadEnabled(),
    fetchNotes: fetchReleaseNotes,
    // Re-resolve the region against the server before every check (see the
    // applyFeedUrl comment for the tradeoff), then aim the feed at that
    // region's CDN root.
    resolveFeedUrl: async () => {
      const region = await refreshServerRegion();
      return `${serverRegionProfile(region).cdnBase}/desktop/`;
    },
    // setFeedURL 会丢弃 app-update.yml 里烘焙的 channel，必须显式带上
    // （预发版 → alpha，正式版 → latest）。
    updateChannel: updateChannelFromVersion(app.getVersion()),
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
