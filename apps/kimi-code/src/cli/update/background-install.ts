import { spawn } from 'node:child_process';

import { loadTuiConfig } from '#/tui/config';

import { tryAcquireUpdateInstallLock } from './install-lock';
import { readUpdateInstallState, writeUpdateInstallState } from './install-state';
import {
  canAutoInstall,
  logRolloutDecision,
  logUpdateInfo,
  nowIso,
  rolloutTelemetryFor,
  spawnForSource,
  trackUpdateEvent,
  type RolloutTelemetry,
  type RunUpdatePreflightOptions,
  type UpdateLogger,
} from './preflight';
import { refreshUpdateCache } from './refresh';
import { decidePassiveUpdateTarget } from './rollout';
import { detectInstallSource } from './source';
import {
  type InstallSource,
  type UpdateInstallState,
  type UpdateTarget,
} from './types';

const AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD = 2;
const AUTO_INSTALL_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

function failureAttemptsFor(state: UpdateInstallState, target: UpdateTarget): number {
  return state.lastFailure?.version === target.version ? state.lastFailure.attempts : 0;
}

function hasFreshActiveInstall(state: UpdateInstallState, target: UpdateTarget): boolean {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt < AUTO_INSTALL_ACTIVE_TTL_MS;
}

async function shouldAutoInstallUpdates(): Promise<boolean> {
  try {
    const config = await loadTuiConfig();
    return config.upgrade.autoInstall;
  } catch {
    return true;
  }
}

function logUpdateWarn(logger: UpdateLogger, message: string, payload: Record<string, unknown>): void {
  try {
    logger.warn(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

async function startBackgroundInstall(
  state: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
  rolloutTelemetry: RolloutTelemetry,
): Promise<void> {
  const lock = await tryAcquireUpdateInstallLock({ version: target.version });
  if (lock === null) return;

  try {
    const freshState = await readUpdateInstallState().catch(() => state);
    if (
      hasFreshActiveInstall(freshState, target) ||
      failureAttemptsFor(freshState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD
    ) {
      return;
    }

    const startedState: UpdateInstallState = {
      ...freshState,
      active: {
        version: target.version,
        source,
        startedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(startedState);
    trackUpdateEvent(track, 'update_background_install_started', {
      current_version: currentVersion,
      target_version: target.version,
      source,
      ...rolloutTelemetry,
    });
    logUpdateInfo(logger, 'background update install started', {
      currentVersion,
      targetVersion: target.version,
      source,
    });

    const { cmd, args } = spawnForSource(source, target.version, platform);
    let settled = false;

    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      const attempts = failureAttemptsFor(startedState, target) + 1;

      const nextState: UpdateInstallState = succeeded
        ? {
          ...startedState,
          active: null,
          lastFailure: null,
          lastSuccess: {
            version: target.version,
            installedAt: nowIso(),
            notifiedAt: null,
          },
        }
        : {
          ...startedState,
          active: null,
          lastFailure: {
            version: target.version,
            failedAt: nowIso(),
            attempts,
          },
        };
      void writeUpdateInstallState(nextState).catch(() => {});
      if (succeeded) {
        trackUpdateEvent(track, 'update_background_install_succeeded', {
          target_version: target.version,
          source,
        });
        logUpdateInfo(logger, 'background update install succeeded', {
          targetVersion: target.version,
          source,
        });
        return;
      }
      trackUpdateEvent(track, 'update_background_install_failed', {
        target_version: target.version,
        source,
        attempts,
      });
      logUpdateWarn(logger, 'background update install failed', {
        targetVersion: target.version,
        source,
        attempts,
      });
    };

    const child = spawn(cmd, [...args], {
      detached: true,
      stdio: 'ignore',
      shell: platform === 'win32' ? true : undefined,
      // On Windows a detached child gets its own console window; with shell:true
      // that window would flash during a passive background update. Hide it so
      // the silent updater stays silent.
      windowsHide: platform === 'win32' ? true : undefined,
    });
    child.once('error', () => { finish(false); });
    child.once('exit', (code) => { finish(code === 0); });
    child.unref();
  } finally {
    await lock.release().catch(() => {});
  }
}

export async function tryStartAutomaticBackgroundInstall(
  installState: UpdateInstallState,
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
  rolloutTelemetry: RolloutTelemetry,
): Promise<boolean> {
  const sourceCanAutoInstall = canAutoInstall(source, platform);
  const autoInstallUpdates = sourceCanAutoInstall ? await shouldAutoInstallUpdates() : false;
  if (!autoInstallUpdates || !sourceCanAutoInstall) return false;
  if (failureAttemptsFor(installState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD) {
    return false;
  }
  if (!hasFreshActiveInstall(installState, target)) {
    await startBackgroundInstall(
      installState,
      currentVersion,
      target,
      source,
      platform,
      track,
      logger,
      rolloutTelemetry,
    ).catch(() => {});
  }
  return true;
}

export function refreshAndMaybeInstallInBackground(
  currentVersion: string,
  deviceId: string,
  bypassRollout: boolean,
  isInteractive: boolean,
  installState: UpdateInstallState,
  platform: NodeJS.Platform,
  track: RunUpdatePreflightOptions['track'],
  logger: UpdateLogger,
): void {
  void (async () => {
    const refreshed = await refreshUpdateCache();
    if (!isInteractive) return;
    const decision = decidePassiveUpdateTarget(
      currentVersion,
      refreshed.latest,
      refreshed.manifest,
      deviceId,
      new Date(),
      bypassRollout,
    );
    logRolloutDecision('background-refresh', currentVersion, refreshed.latest, refreshed.manifest, decision);
    const target = decision.target;
    if (target === null) return;
    const source = await detectInstallSource().catch(() => 'unsupported' as const);
    await tryStartAutomaticBackgroundInstall(
      installState,
      currentVersion,
      target,
      source,
      platform,
      track,
      logger,
      rolloutTelemetryFor(deviceId, target.version, refreshed.manifest, bypassRollout),
    );
  })().catch(() => {});
}
