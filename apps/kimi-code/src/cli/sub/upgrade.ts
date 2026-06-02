import { log, type Logger } from '@moonshot-ai/kimi-code-sdk';
import { track as trackTelemetry, type TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';
import { detectInstallSource } from '#/cli/update/source';
import {
  canAutoInstall,
  installCommandFor,
  installUpdate as installUpdateForeground,
  renderInstallSuccessMessage,
  renderManualUpdateMessage,
} from '#/cli/update/preflight';
import {
  promptForInstallChoice,
  type InstallPromptChoiceValue,
  type InstallPromptOptions,
} from '#/cli/update/prompt';
import {
  NPM_PACKAGE_NAME,
  type InstallSource,
  type UpdateCache,
} from '#/cli/update/types';

interface WritableLike {
  write(chunk: string): boolean;
}

type UpgradeTrack = (event: string, properties?: TelemetryProperties) => void;
type UpgradeLogger = Pick<Logger, 'info' | 'warn'>;

export interface UpgradeDeps {
  readonly refreshUpdateCache: () => Promise<UpdateCache>;
  readonly detectInstallSource: () => Promise<InstallSource>;
  readonly installUpdate: (
    source: InstallSource,
    version: string,
    platform: NodeJS.Platform,
  ) => Promise<void>;
  readonly promptForInstallChoice: (
    options: InstallPromptOptions,
  ) => Promise<InstallPromptChoiceValue>;
  readonly platform: NodeJS.Platform;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly track: UpgradeTrack;
  readonly logger: UpgradeLogger;
}

export async function handleUpgrade(
  currentVersion: string,
  overrides: Partial<UpgradeDeps> = {},
): Promise<number> {
  const deps = createDefaultUpgradeDeps(overrides);

  let cache: UpdateCache;
  try {
    cache = await deps.refreshUpdateCache();
  } catch (error) {
    const reason = formatErrorMessage(error);
    trackUpgradeEvent(deps.track, 'upgrade_command_failed', {
      current_version: currentVersion,
      stage: 'refresh',
      reason,
    });
    logUpgradeWarn(deps.logger, 'manual upgrade check failed', {
      currentVersion,
      error,
    });
    deps.stderr.write(`error: failed to check for updates: ${reason}\n`);
    return 1;
  }

  const target = selectUpdateTarget(currentVersion, cache.latest);
  if (target === null) {
    trackUpgradeEvent(deps.track, 'upgrade_command_no_update', {
      current_version: currentVersion,
    });
    logUpgradeInfo(deps.logger, 'manual upgrade no update', {
      currentVersion,
    });
    deps.stdout.write(`Kimi Code is already up to date (${formatDisplayVersion(currentVersion)}).\n`);
    return 0;
  }

  const source = await deps.detectInstallSource().catch(() => 'unsupported' as const);
  const installCommand = installCommandFor(source, target.version, deps.platform);
  if (!canAutoInstall(source, deps.platform)) {
    trackUpgradeEvent(deps.track, 'upgrade_command_manual_command', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    logUpgradeInfo(deps.logger, 'manual upgrade command shown', {
      currentVersion,
      targetVersion: target.version,
      source,
    });
    deps.stdout.write(renderManualUpdateMessage(currentVersion, target, source, installCommand));
    return 0;
  }

  trackUpgradeEvent(deps.track, 'upgrade_command_prompted', {
    current_version: currentVersion,
    target_version: target.version,
    source,
  });
  logUpgradeInfo(deps.logger, 'manual upgrade prompted', {
    currentVersion,
    targetVersion: target.version,
    source,
  });
  const choice = await deps.promptForInstallChoice({
    currentVersion,
    target,
    installCommand,
    installSource: source,
  });
  if (choice === 'skip') {
    trackUpgradeEvent(deps.track, 'upgrade_command_skipped', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    logUpgradeInfo(deps.logger, 'manual upgrade skipped', {
      currentVersion,
      targetVersion: target.version,
      source,
    });
    return 0;
  }

  try {
    trackUpgradeEvent(deps.track, 'upgrade_command_install_selected', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    await deps.installUpdate(source, target.version, deps.platform);
    trackUpgradeEvent(deps.track, 'upgrade_command_succeeded', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    logUpgradeInfo(deps.logger, 'manual upgrade install succeeded', {
      currentVersion,
      targetVersion: target.version,
      source,
    });
    deps.stdout.write(renderInstallSuccessMessage(target));
    return 0;
  } catch (error) {
    trackUpgradeEvent(deps.track, 'upgrade_command_failed', {
      current_version: currentVersion,
      target_version: target.version,
      source,
      stage: 'install',
      reason: formatErrorMessage(error),
    });
    logUpgradeWarn(deps.logger, 'manual upgrade install failed', {
      currentVersion,
      targetVersion: target.version,
      source,
      error,
    });
    deps.stderr.write(
      `warning: failed to install ${NPM_PACKAGE_NAME}@${target.version}: ` +
        `${formatErrorMessage(error)}\n`,
    );
    return 1;
  }
}

function createDefaultUpgradeDeps(overrides: Partial<UpgradeDeps>): UpgradeDeps {
  return {
    refreshUpdateCache: overrides.refreshUpdateCache ?? (() => refreshUpdateCache()),
    detectInstallSource: overrides.detectInstallSource ?? (() => detectInstallSource()),
    installUpdate: overrides.installUpdate ?? installUpdateForeground,
    promptForInstallChoice: overrides.promptForInstallChoice ?? promptForInstallChoice,
    platform: overrides.platform ?? process.platform,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    track: overrides.track ?? trackTelemetry,
    logger: overrides.logger ?? log,
  };
}

function formatDisplayVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackUpgradeEvent(
  track: UpgradeTrack,
  event: string,
  properties: TelemetryProperties,
): void {
  try {
    track(event, properties);
  } catch {
    // Telemetry must never affect upgrade flow.
  }
}

function logUpgradeInfo(logger: UpgradeLogger, message: string, payload: Record<string, unknown>): void {
  try {
    logger.info(message, payload);
  } catch {
    // Diagnostic logging must never affect upgrade flow.
  }
}

function logUpgradeWarn(logger: UpgradeLogger, message: string, payload: Record<string, unknown>): void {
  try {
    logger.warn(message, payload);
  } catch {
    // Diagnostic logging must never affect upgrade flow.
  }
}
