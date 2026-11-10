import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';
import {
  CLIENT_UPGRADE_POLICY_CONFIG_NAME,
  clientUpgradePolicySchema,
  isUpgradeRequired,
} from '@moonshot-ai/kimi-code-product/client-configs/node';

import { INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS, NPM_PACKAGE_NAME } from '#/constant/app';
import { clientConfigs } from '#/utils/client-configs';

import {
  canAutoInstall,
  installCommandFor,
  installUpdate,
  renderInstallSuccessMessage,
  renderManualUpdateMessage,
} from './preflight';
import { promptForForcedUpgradeChoice } from './forced-prompt';
import { refreshUpdateCache } from './refresh';
import { decideUpdate, updateChannelForVersion } from './select';
import { detectInstallSource } from './source';
import type { UpgradePlan } from './types';

export type ForcedUpgradePreflightResult = 'continue' | 'skip-passive' | 'exit' | 'interrupt';

export interface RunForcedUpgradePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
  readonly track?: (event: string, properties?: TelemetryProperties) => void;
}

const SKIP_DELAY_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runForcedUpgradePreflight(
  currentVersion: string,
  options: RunForcedUpgradePreflightOptions = {},
): Promise<ForcedUpgradePreflightResult> {
  const isInteractive = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) return 'continue';
  const policy = await clientConfigs.fetch(CLIENT_UPGRADE_POLICY_CONFIG_NAME, clientUpgradePolicySchema, { timeoutMs: 2_000 });
  const minimumVersion = policy?.cliMinVersion ?? null;
  if (!isUpgradeRequired(currentVersion, minimumVersion) || minimumVersion === null) return 'continue';

  const stdout = options.stdout ?? process.stdout;
  const channel = updateChannelForVersion(currentVersion);
  const platform = process.platform;
  const source = await detectInstallSource().catch(() => 'unsupported' as const);
  if (source === 'unsupported') return 'continue';
  const baseProperties = {
    client: 'cli',
    current_version: currentVersion,
    minimum_version: minimumVersion,
    channel,
  };
  const track = (event: string, properties: TelemetryProperties = {}): void => {
    try {
      options.track?.(event, { ...baseProperties, ...properties });
    } catch {}
  };
  let state = 'idle';
  let targetVersion: string | undefined;
  const transition = (
    next: string,
    attempt: number,
    errorStage?: 'check' | 'download' | 'install',
    errorClass?: string,
  ): void => {
    if (state === next) return;
    const previous = state;
    state = next;
    track('forced_upgrade_state_changed', {
      from_state: previous,
      to_state: next,
      target_version: targetVersion ?? null,
      attempt,
      error_stage: errorStage ?? null,
      error_class: errorClass ?? null,
    });
  };

  let skipAvailableAt: number | null = null;
  let promptShown = false;
  let attempt = 0;
  let lastError: string | undefined;
  while (true) {
    attempt += 1;
    let plan: UpgradePlan | null = null;
    if (lastError === undefined) {
      transition('checking', attempt);
      try {
        const feed = await refreshUpdateCache({ channel, timeoutMs: INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS });
        const candidate = decideUpdate(currentVersion, feed);
        if (candidate.kind === 'upgrade') {
          targetVersion = candidate.target.version;
          if (isUpgradeRequired(candidate.target.version, minimumVersion)) {
            lastError = `Version ${minimumVersion} or newer is not available in the ${channel} channel yet.`;
            transition('error', attempt, 'check', 'target_below_minimum');
          } else {
            plan = candidate;
          }
        } else {
          lastError = `Version ${minimumVersion} or newer is not available in the ${channel} channel yet.`;
          transition('error', attempt, 'check', 'target_unavailable');
        }
      } catch (error) {
        lastError = `Failed to check for updates: ${errorMessage(error)}`;
        transition('error', attempt, 'check', 'check_failed');
      }
    }

    skipAvailableAt ??= Date.now() + SKIP_DELAY_MS;
    if (!promptShown) {
      promptShown = true;
      track('forced_upgrade_prompt_shown', { target_version: targetVersion ?? null });
    }
    const canInstall = lastError !== undefined || (plan !== null && canAutoInstall(source, platform));
    if (plan !== null && !canInstall) {
      stdout.write(renderManualUpdateMessage(
        currentVersion,
        plan,
        source,
        installCommandFor(source, plan.target.version, platform, channel),
      ));
    }
    const action = await promptForForcedUpgradeChoice({
      currentVersion,
      minimumVersion,
      targetVersion,
      error: lastError,
      canInstall,
      skipAvailableAt,
    });
    if (action === 'exit') return 'interrupt';
    if (action === 'skip') {
      track('forced_upgrade_action', {
        action: 'skip',
        trigger: lastError === undefined ? 'initial' : 'error',
        waited_ms: Date.now() - (skipAvailableAt - SKIP_DELAY_MS),
        target_version: targetVersion ?? null,
        attempt,
      });
      return 'skip-passive';
    }
    if (plan === null) {
      track('forced_upgrade_action', {
        action: 'retry',
        trigger: 'error',
        error_stage: 'check',
        target_version: targetVersion ?? null,
        attempt,
      });
      lastError = undefined;
      continue;
    }

    track('forced_upgrade_action', {
      action: lastError === undefined ? 'upgrade' : 'retry',
      trigger: lastError === undefined ? 'initial' : 'error',
      error_stage: lastError === undefined ? null : 'download',
      target_version: plan.target.version,
      attempt,
    });
    transition('downloading', attempt);
    try {
      await installUpdate(source, plan, platform);
      transition('installing', attempt);
      stdout.write(renderInstallSuccessMessage(plan));
      return 'exit';
    } catch (error) {
      lastError = `Failed to install ${NPM_PACKAGE_NAME}@${plan.target.version}: ${errorMessage(error)}`;
      transition('error', attempt, 'download', 'install_failed');
    }
  }
}
