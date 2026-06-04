import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { loadTuiConfig, type TuiConfig } from '../config';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig();
  applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus('TUI config reloaded.', host.state.theme.colors.success);
}

export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig();
  const session = host.session;

  if (session !== undefined) {
    await session.reloadSession();
    await host.reloadCurrentSessionView(session, 'Session reloaded.');
  }

  const config = await host.harness.getConfig({ reload: true });
  setExperimentalFeatures(await host.harness.getExperimentalFeatures());
  host.refreshSlashCommandAutocomplete();
  applyRuntimeConfig(host, config);
  applyReloadedTuiConfig(host, tuiConfig);

  if (session === undefined) {
    host.showStatus(
      'Runtime and TUI config reloaded; no active session.',
      host.state.theme.colors.success,
    );
  }
}

export function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): void {
  const resolved = config.theme === 'auto' ? host.state.theme.resolvedTheme : config.theme;
  host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    notifications: config.notifications,
    upgrade: config.upgrade,
  });
}

function applyRuntimeConfig(host: SlashCommandHost, config: KimiConfig): void {
  host.setAppState({
    availableModels: config.models ?? {},
    availableProviders: config.providers ?? {},
  });
}
