import { track as trackTelemetry } from '@moonshot-ai/kimi-telemetry';

import { detectInstallSource } from '#/cli/update/source';
import {
  canAutoInstall,
  installCommandFor,
  renderManualUpdateMessage,
} from '#/cli/update/preflight';
import { refreshUpdateCache } from '#/cli/update/refresh';
import { selectUpdateTarget } from '#/cli/update/select';
import { type UpdateCache } from '#/cli/update/types';
import type { SlashCommandHost } from './dispatch';

export async function handleCheckUpdateCommand(host: SlashCommandHost): Promise<void> {
  const currentVersion = host.state.appState.version;

  let cache: UpdateCache;
  try {
    cache = await refreshUpdateCache();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    host.showError(`Failed to check for updates: ${reason}`);
    trackTelemetry('slash_check_update_failed', { current_version: currentVersion, reason });
    return;
  }

  const target = selectUpdateTarget(currentVersion, cache.latest);
  if (target === null) {
    host.showStatus(`Kimi Code is already up to date (${formatDisplayVersion(currentVersion)}).`);
    trackTelemetry('slash_check_update_no_update', { current_version: currentVersion });
    return;
  }

  host.showNotice(
    'Update Available',
    `Kimi Code ${formatDisplayVersion(currentVersion)} → ${formatDisplayVersion(target.version)}\nRun /update to install.`,
  );
  trackTelemetry('slash_check_update_available', {
    current_version: currentVersion,
    target_version: target.version,
  });
}

export async function handleUpdateCommand(host: SlashCommandHost): Promise<void> {
  const currentVersion = host.state.appState.version;

  let cache: UpdateCache;
  try {
    cache = await refreshUpdateCache();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    host.showError(`Failed to check for updates: ${reason}`);
    trackTelemetry('slash_update_failed', { current_version: currentVersion, reason });
    return;
  }

  const target = selectUpdateTarget(currentVersion, cache.latest);
  if (target === null) {
    host.showStatus(`Kimi Code is already up to date (${formatDisplayVersion(currentVersion)}).`);
    trackTelemetry('slash_update_no_update', { current_version: currentVersion });
    return;
  }

  const source = await detectInstallSource().catch(() => 'unsupported' as const);
  const installCommand = installCommandFor(source, target.version, process.platform);

  if (!canAutoInstall(source, process.platform)) {
    host.showNotice(
      'Manual Update Required',
      renderManualUpdateMessage(currentVersion, target, source, installCommand),
    );
    trackTelemetry('slash_update_manual', {
      current_version: currentVersion,
      target_version: target.version,
      source,
    });
    return;
  }

  // For auto-installable sources, show a prompt-like notice
  host.showNotice(
    'Update Ready',
    `Install Kimi Code ${formatDisplayVersion(target.version)} now?\n\n${installCommand}\n\n(Auto-install via TUI is not yet supported — please run the command above in your terminal)`,
  );
  trackTelemetry('slash_update_prompted', {
    current_version: currentVersion,
    target_version: target.version,
    source,
  });
}

function formatDisplayVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}
