
import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';

import { IPC } from '../ipc/ipc-channels';
import { log } from '../diagnostics/log';
import { isPreviewVersion } from './release-channel';
import { refreshServerRegion, serverRegionProfile, whenServerRegionSource } from '../server/region';
import { isUpdateAutoDownloadEnabled, setUpdateAutoDownloadEnabled } from '../app/ui-state';
import { markQuitting, sendToRenderer } from '../window/main-window';
import { trackDesktopEvent } from '../diagnostics/track';
import { isUpdateRolloutEligible, type UpdateRolloutInfo } from './update-rollout';

export type UpdateState = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface ReleaseNotes {
  zh?: string;
  en?: string;
}

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
  releaseNotes?: ReleaseNotes;
}

export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

export const UPDATE_CHECK_TIMED_OUT = 'update check timed out';

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
  setFeedURL?(options: unknown): void;
  allowPrerelease?: boolean;
  isUserWithinRollout?(info: UpdateRolloutInfo): boolean | Promise<boolean>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateController {
  getStatus(): UpdateStatus;
  check(): Promise<UpdateCheckResult>;
  download(): void;
  install(): Promise<void>;
  setAutoDownload(enabled: boolean): void;
  stop(): void;
}

export interface RestartDecision {
  readonly proceed: boolean;
  readonly continueSessionIds: readonly string[];
}

export interface UpdateRestartDeps {
  confirmRestart: () => Promise<RestartDecision>;
  prepareSessionContinue: (sessionIds: readonly string[]) => void;
}

export interface StartAutoUpdaterDeps extends UpdateRestartDeps {
  updater: UpdaterLike;
  send: (status: UpdateStatus) => void;
  isPackaged: boolean;
  initialDelayMs?: number;
  intervalMs?: number;
  autoDownload?: boolean;
  fetchNotes?: (version: string) => Promise<ReleaseNotes>;
  resolveFeedUrl?: () => Promise<string>;
  resolveDeviceId?: () => string;
  updateChannel?: string;
}

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CANARY_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MANUAL_CHECK_TIMEOUT_MS = 30_000;
const CHECK_CHAIN_TIMEOUT_MS = 60_000;

export function updateChannelFromVersion(version: string): string {
  const tag = version.split('-')[1]?.split('.')[0];
  if (tag === 'canary' || tag === 'preview') return tag;
  return 'latest';
}

export function startAutoUpdater(deps: StartAutoUpdaterDeps): UpdateController | null {
  if (!deps.isPackaged) {
    return null;
  }
  const { updater, send } = deps;

  let current: UpdateStatus = { state: 'idle' };
  const setStatus = (next: UpdateStatus, errorClass?: string): void => {
    const previousState = current.state;
    const keepNotes =
      next.version !== undefined && next.version === current.version ? current.releaseNotes : undefined;
    current = { ...next, releaseNotes: next.releaseNotes ?? keepNotes };
    send(current);
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

  let bypassRollout = false;
  let manuallyApprovedVersion: string | null = null;
  const resolveDeviceId = (): string | Promise<string> => {
    if (deps.resolveDeviceId !== undefined) return deps.resolveDeviceId();
    return Promise.all([
      import('@moonshot-ai/kimi-code-sdk'),
      import('../app/identity'),
    ]).then(([{ resolveKimiHome }, { resolveDesktopHostIdentity }]) => resolveDesktopHostIdentity(resolveKimiHome()).deviceId);
  };
  updater.isUserWithinRollout = (info) => {
    if (bypassRollout || info.version === manuallyApprovedVersion) return true;
    const deviceId = resolveDeviceId();
    if (typeof deviceId === 'string') {
      const eligible = isUpdateRolloutEligible(info, deviceId, new Date());
      if (!eligible) log.info(`[kimi-desktop] update held by rollout: ${info.version}`);
      return eligible;
    }
    return deviceId.then((value) => {
      const eligible = isUpdateRolloutEligible(info, value, new Date());
      if (!eligible) log.info(`[kimi-desktop] update held by rollout: ${info.version}`);
      return eligible;
    });
  };

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
        notesRequestedFor = null;
      });
  };

  updater.on('update-available', (info) => {
    if (
      (current.state === 'downloading' || current.state === 'downloaded') &&
      current.version === info.version
    ) {
      return;
    }
    if (manuallyApprovedVersion !== null && manuallyApprovedVersion !== info.version) {
      manuallyApprovedVersion = null;
    }
    automaticDownloadInFlight = updater.autoDownload;
    if (bypassRollout) manuallyApprovedVersion = info.version;
    setStatus({ state: 'available', version: info.version, releaseDate: info.releaseDate });
    log.info(`[kimi-desktop] update available: ${info.version}`);
    requestNotes(info.version);
  });
  updater.on('update-not-available', () => {
    automaticDownloadInFlight = false;
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
    automaticDownloadInFlight = false;
    if (manuallyApprovedVersion === info.version) manuallyApprovedVersion = null;
    setStatus({ state: 'downloaded', version: info.version, releaseDate: info.releaseDate });
    log.info(`[kimi-desktop] update downloaded: ${info.version}`);
    requestNotes(info.version);
  });
  updater.on('error', (error) => {
    automaticDownloadInFlight = false;
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
        setFeed({ provider: 'generic', url, channel: updateChannel });
        appliedFeedUrl = url;
      }
    } catch {}
  };

  let stopped = false;
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
  const whenFeedReady = async (): Promise<void> => {
    const ready = await whenServerRegionSource();
    if (!ready) {
      armLateRecheck();
    }
    await applyFeedUrl();
  };

  let checkChain: Promise<unknown> = Promise.resolve();
  let pendingAttempt: Promise<unknown> | null = null;
  let automaticDownloadInFlight = false;
  const runCheckSerialized = (bypass = false, onStart?: () => boolean): Promise<unknown> => {
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
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      if (onStart?.() === false) return undefined;
      bypassRollout = bypass;
      const attempt = updater.checkForUpdates().then((result) => {
        const downloadPromise = (result as { downloadPromise?: Promise<unknown> } | null)?.downloadPromise;
        void downloadPromise?.catch(() => {});
        return result;
      });
      pendingAttempt = attempt;
      const release = (): void => {
        if (pendingAttempt === attempt) {
          pendingAttempt = null;
          bypassRollout = false;
        }
      };
      void attempt.then(release, release);
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
        void runCheckSerialized(true, () => {
          if (settled) return false;
          attachAndRun();
          return true;
        }).catch(onCheckRejected);
      } else {
        void whenFeedReady().then(() => {
          if (settled) return;
          void runCheckSerialized(true, () => {
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
    const automatic = automaticDownloadInFlight && current.state === 'available';
    setStatus({ state: 'downloading', version: current.version, releaseDate: current.releaseDate, percent: 0 });
    if (automatic) return;
    log.info(`[kimi-desktop] update download started: ${current.version ?? 'unknown'}`);
    void updater.downloadUpdate().catch(() => {});
  };

  let installPending = false;
  return {
    getStatus: () => current,
    check: checkNow,
    download,
    install: async () => {
      if (current.state !== 'downloaded' || installPending) {
        return;
      }
      installPending = true;
      try {
        const decision = await deps.confirmRestart().catch((error: unknown): RestartDecision => {
          log.warn(`[kimi-desktop] update quit confirmation skipped: check failed (${error instanceof Error ? error.message : String(error)})`);
          return { proceed: true, continueSessionIds: [] };
        });
        if (!decision.proceed) return;
        try {
          deps.prepareSessionContinue(decision.continueSessionIds);
        } catch (error) {
          log.warn(`[kimi-desktop] sessions will not continue after the update restart (${error instanceof Error ? error.message : String(error)})`);
        }
        log.info(`[kimi-desktop] installing update ${current.version ?? 'unknown'} (quitAndInstall)`);
        markQuitting();
        updater.quitAndInstall(true, true);
      } finally {
        installPending = false;
      }
    },
    setAutoDownload: (enabled) => {
      updater.autoDownload = enabled;
    },
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

function releaseNotesBase(): string {
  return `${serverRegionProfile().cdnBase}/desktop/`;
}

export async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const notes: ReleaseNotes = {};
  await Promise.all(
    (['zh', 'en'] as const).map(async (lang) => {
      try {
        const response = await net.fetch(`${releaseNotesBase()}binaries/${version}/changelog.${lang}.md`);
        if (response.ok) {
          notes[lang] = await response.text();
        }
      } catch {}
    }),
  );
  return notes;
}

let controller: UpdateController | null = null;

export function initAutoUpdater(restart: UpdateRestartDeps): void {
  if (isPreviewVersion(app.getVersion())) {
    return;
  }
  const channel = updateChannelFromVersion(app.getVersion());
  if (channel === 'canary') autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = false;
  const isSupported = autoUpdater.isUpdateSupported.bind(autoUpdater);
  autoUpdater.isUpdateSupported = (info) =>
    updateChannelFromVersion(info.version) === channel && isSupported(info);
  controller = startAutoUpdater({
    updater: autoUpdater,
    send: (status) => sendToRenderer(IPC.updateStatus, status),
    ...restart,
    isPackaged: app.isPackaged,
    intervalMs: channel === 'canary' ? CANARY_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS,
    autoDownload: isUpdateAutoDownloadEnabled(),
    fetchNotes: fetchReleaseNotes,
    resolveFeedUrl: async () => {
      const region = await refreshServerRegion();
      return `${serverRegionProfile(region).cdnBase}/desktop/`;
    },
    updateChannel: channel,
  });
}

export function getUpdateStatus(): UpdateStatus {
  return controller?.getStatus() ?? { state: 'idle' };
}

export function requestUpdateCheck(): Promise<UpdateCheckResult> {
  return controller?.check() ?? Promise.resolve({ outcome: 'unsupported' });
}

export function requestUpdateDownload(): void {
  controller?.download();
}

export function requestUpdateInstall(): Promise<void> {
  return controller?.install() ?? Promise.resolve();
}

export function getUpdateAutoDownload(): boolean {
  return isUpdateAutoDownloadEnabled();
}

export function setUpdateAutoDownload(enabled: boolean): void {
  setUpdateAutoDownloadEnabled(enabled);
  controller?.setAutoDownload(enabled);
}
