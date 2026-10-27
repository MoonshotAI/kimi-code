import { log, type Logger } from '@moonshot-ai/kimi-code-sdk';
import { track as trackTelemetry, type TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import { INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS } from '#/constant/app';

import { refreshUpdateCache } from '#/cli/update/refresh';
import { decideUpdate, formatUpdateChannelWarning, resolveUpdateChannel } from '#/cli/update/select';
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
import type {
  ActionableUpdatePlan,
  InstallIntent,
  InstallSource,
  UpdateCache,
  UpdateChannel,
} from '#/cli/update/types';

interface WritableLike {
  write(chunk: string): boolean;
}

type UpgradeTrack = (event: string, properties?: TelemetryProperties) => void;
type UpgradeLogger = Pick<Logger, 'info' | 'warn'>;

export interface UpgradeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly refreshUpdateCache: (channel: UpdateChannel) => Promise<UpdateCache>;
  readonly detectInstallSource: {
    (options: { readonly allowGlobalPrefix: false }): Promise<InstallSource | null>;
    (): Promise<InstallSource>;
  };
  readonly installUpdate: (
    source: InstallSource,
    plan: ActionableUpdatePlan,
    platform: NodeJS.Platform,
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
  const sourceHint = await deps.detectInstallSource({ allowGlobalPrefix: false }).catch(() => null);
  const selection = resolveUpdateChannel(currentVersion, sourceHint ?? 'unsupported', deps.env);
  const channelWarning = formatUpdateChannelWarning(selection);
  if (channelWarning !== null) deps.stderr.write(channelWarning);

  let cache: UpdateCache;
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

  const plan = decideUpdate(currentVersion, cache);
  if (plan.kind === 'none') {
    trackUpgradeEvent(deps.track, 'upgrade_command_no_update', {
      current_version: currentVersion,
    });
    logUpgradeInfo(deps.logger, 'manual upgrade no update', {
      currentVersion,
      plan: plan.kind,
    });
    deps.stdout.write(`Kimi Code is already up to date (${formatDisplayVersion(currentVersion)}).\n`);
    return 0;
  }

  const source = sourceHint ?? await deps.detectInstallSource().catch(() => 'unsupported' as const);
  const target = plan.target;
  const intent: InstallIntent = plan.kind;
  const installCommand = installCommandFor(source, target.version, deps.platform, target.channel);
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
    deps.stdout.write(renderManualUpdateMessage(currentVersion, plan, source, installCommand));
    return 0;
  }

  if (!deps.yes) {
    trackUpgradeEvent(deps.track, 'upgrade_command_prompted', eventBase);
    logUpgradeInfo(deps.logger, 'manual upgrade prompted', logBase);
    const choice = await deps.promptForInstallChoice({
      currentVersion,
      plan,
      installCommand,
      installSource: source,
    });
    if (choice === 'skip') {
      trackUpgradeEvent(deps.track, 'upgrade_command_skipped', eventBase);
      logUpgradeInfo(deps.logger, 'manual upgrade skipped', logBase);
      return 0;
    }
  }

  try {
    trackUpgradeEvent(deps.track, 'upgrade_command_install_selected', eventBase);
    await deps.installUpdate(source, plan, deps.platform);
    trackUpgradeEvent(deps.track, 'upgrade_command_succeeded', eventBase);
    logUpgradeInfo(deps.logger, 'manual upgrade install succeeded', logBase);
    deps.stdout.write(renderInstallSuccessMessage(plan));
    return 0;
  } catch (error) {
    trackUpgradeEvent(deps.track, 'upgrade_command_failed', {
      ...eventBase,
      stage: 'install',
      reason: formatErrorMessage(error),
    });
    logUpgradeWarn(deps.logger, 'manual upgrade install failed', { ...logBase, error });
    deps.stderr.write(
      `warning: failed to install @moonshot-ai/kimi-code@${target.version}: ` +
        `${formatErrorMessage(error)}\n`,
    );
    return 1;
  }
}

function createDefaultUpgradeDeps(overrides: Partial<UpgradeDeps>): UpgradeDeps {
  return {
    env: overrides.env ?? process.env,
    refreshUpdateCache:
      overrides.refreshUpdateCache ??
      ((channel) => refreshUpdateCache({ channel, timeoutMs: INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS })),
    detectInstallSource: overrides.detectInstallSource ?? detectInstallSource,
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
