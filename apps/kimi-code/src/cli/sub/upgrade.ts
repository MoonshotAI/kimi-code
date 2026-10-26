import { log, type Logger } from '@moonshot-ai/kimi-code-sdk';
import { track as trackTelemetry, type TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import { INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS } from '#/constant/app';

import { refreshUpdateCache, type RefreshedUpdateCache } from '#/cli/update/refresh';
import { planManualUpdate, resolveUpdateChannel, UPDATE_CHANNEL_ENV } from '#/cli/update/select';
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
  type ChannelSelection,
  type InstallIntent,
  type InstallSource,
  type UpdateChannel,
  type UpdateTarget,
} from '#/cli/update/types';

interface WritableLike {
  write(chunk: string): boolean;
}

type UpgradeTrack = (event: string, properties?: TelemetryProperties) => void;
type UpgradeLogger = Pick<Logger, 'info' | 'warn'>;

export interface UpgradeDeps {
  readonly channelSelection: ChannelSelection;
  readonly refreshUpdateCache: (channel: UpdateChannel) => Promise<RefreshedUpdateCache>;
  readonly detectInstallSource: () => Promise<InstallSource>;
  readonly installUpdate: (
    source: InstallSource,
    version: string,
    platform: NodeJS.Platform,
    intent: InstallIntent,
  ) => Promise<void>;
  readonly promptForInstallChoice: (
    options: InstallPromptOptions,
  ) => Promise<InstallPromptChoiceValue>;
  readonly platform: NodeJS.Platform;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly isInteractive: boolean;
  readonly yes: boolean;
  readonly track: UpgradeTrack;
  readonly logger: UpgradeLogger;
}

export async function handleUpgrade(
  currentVersion: string,
  overrides: Partial<UpgradeDeps> = {},
): Promise<number> {
  const deps = createDefaultUpgradeDeps(overrides);
  const selection = deps.channelSelection;
  if (selection.origin === 'invalid') {
    deps.stderr.write(
      `warning: ignoring ${UPDATE_CHANNEL_ENV}=${JSON.stringify(selection.raw)}; ` +
        'expected "stable" or "canary". Using stable.\n',
    );
  }

  let cache: RefreshedUpdateCache;
  try {
    cache = await deps.refreshUpdateCache(selection.channel);
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
  if (cache.degraded) {
    deps.stderr.write('warning: the canary channel is unreachable; using the stable release instead.\n');
  }

  const plan = planManualUpdate(currentVersion, cache.latest, selection);
  if (plan.kind === 'up-to-date' || plan.kind === 'canary-hold') {
    trackUpgradeEvent(deps.track, 'upgrade_command_no_update', {
      current_version: currentVersion,
      canary_hold: plan.kind === 'canary-hold',
    });
    logUpgradeInfo(deps.logger, 'manual upgrade no update', {
      currentVersion,
      plan: plan.kind,
    });
    deps.stdout.write(
      plan.kind === 'canary-hold'
        ? renderCanaryHoldMessage(currentVersion, plan.stable)
        : `Kimi Code is already up to date (${formatDisplayVersion(currentVersion)}).\n`,
    );
    return 0;
  }

  const target = plan.target;
  const intent: InstallIntent = plan.kind === 'switch-to-stable' ? 'switch-channel' : 'upgrade';
  const source = await deps.detectInstallSource().catch(() => 'unsupported' as const);
  const installCommand = installCommandFor(source, target.version, deps.platform);
  const eventBase = {
    current_version: currentVersion,
    target_version: target.version,
    source,
    intent,
  };
  const logBase = {
    currentVersion,
    targetVersion: target.version,
    source,
    intent,
  };
  const sourceCanAutoInstall = canAutoInstall(source, deps.platform);
  if (!sourceCanAutoInstall || (!deps.yes && !deps.isInteractive)) {
    trackUpgradeEvent(deps.track, 'upgrade_command_manual_command', eventBase);
    logUpgradeInfo(deps.logger, 'manual upgrade command shown', logBase);
    deps.stdout.write(
      intent === 'switch-channel'
        ? renderSwitchToStableMessage(currentVersion, target, sourceCanAutoInstall, installCommand)
        : renderManualUpdateMessage(currentVersion, target, source, installCommand),
    );
    return 0;
  }

  if (!deps.yes) {
    trackUpgradeEvent(deps.track, 'upgrade_command_prompted', eventBase);
    logUpgradeInfo(deps.logger, 'manual upgrade prompted', logBase);
    const choice = await deps.promptForInstallChoice({
      currentVersion,
      target,
      installCommand,
      installSource: source,
      intent,
    });
    if (choice === 'skip') {
      trackUpgradeEvent(deps.track, 'upgrade_command_skipped', eventBase);
      logUpgradeInfo(deps.logger, 'manual upgrade skipped', logBase);
      return 0;
    }
  }

  try {
    trackUpgradeEvent(deps.track, 'upgrade_command_install_selected', eventBase);
    await deps.installUpdate(source, target.version, deps.platform, intent);
    trackUpgradeEvent(deps.track, 'upgrade_command_succeeded', eventBase);
    logUpgradeInfo(deps.logger, 'manual upgrade install succeeded', logBase);
    deps.stdout.write(
      intent === 'switch-channel'
        ? `Switched ${NPM_PACKAGE_NAME} to stable ${target.version}. Restart the CLI to use it.\n`
        : renderInstallSuccessMessage(target),
    );
    return 0;
  } catch (error) {
    trackUpgradeEvent(deps.track, 'upgrade_command_failed', {
      ...eventBase,
      stage: 'install',
      reason: formatErrorMessage(error),
    });
    logUpgradeWarn(deps.logger, 'manual upgrade install failed', { ...logBase, error });
    deps.stderr.write(
      `warning: failed to install ${NPM_PACKAGE_NAME}@${target.version}: ` +
        `${formatErrorMessage(error)}\n`,
    );
    return 1;
  }
}

function renderCanaryHoldMessage(currentVersion: string, stable: string): string {
  return (
    `Kimi Code is on the canary build ${formatDisplayVersion(currentVersion)}; ` +
    `the stable release is ${formatDisplayVersion(stable)}.\n` +
    'It stays on this build until a newer stable release ships.\n' +
    `To switch back to stable now, set ${UPDATE_CHANNEL_ENV}=stable and run kimi update.\n`
  );
}

function renderSwitchToStableMessage(
  currentVersion: string,
  target: UpdateTarget,
  sourceCanAutoInstall: boolean,
  installCommand: string,
): string {
  return (
    `Kimi Code is on the canary build ${formatDisplayVersion(currentVersion)}; ` +
    `switching to stable installs the older release ${formatDisplayVersion(target.version)}.\n` +
    'Sessions or settings written by the canary build may not open in it.\n' +
    (sourceCanAutoInstall
      ? 'To switch, run: kimi update --yes\n'
      : `To switch manually, run: ${installCommand}\n`)
  );
}

function createDefaultUpgradeDeps(overrides: Partial<UpgradeDeps>): UpgradeDeps {
  return {
    channelSelection: overrides.channelSelection ?? resolveUpdateChannel(),
    refreshUpdateCache:
      overrides.refreshUpdateCache ??
      ((channel) => refreshUpdateCache({ channel, timeoutMs: INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS })),
    detectInstallSource: overrides.detectInstallSource ?? (() => detectInstallSource()),
    installUpdate: overrides.installUpdate ?? installUpdateForeground,
    promptForInstallChoice: overrides.promptForInstallChoice ?? promptForInstallChoice,
    platform: overrides.platform ?? process.platform,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    isInteractive: overrides.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY),
    yes: overrides.yes ?? false,
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
