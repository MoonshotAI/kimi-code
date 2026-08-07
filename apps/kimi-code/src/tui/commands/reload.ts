import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme, lightColors } from '#/tui/theme';
import { loadTuiConfig, type TuiConfig } from '../config';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  await applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus('TUI config reloaded.', 'success');
}

export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig(undefined, (message) =>
    host.showStatus(message, 'warning'),
  );
  const session = host.session;

  if (session !== undefined) {
    await session.reloadSession({ forcePluginSessionStartReminder: true });
    await host.reloadCurrentSessionView(session, 'Session reloaded.');
  }

  const config = await host.harness.getConfig({ reload: true });
  setExperimentalFeatures(await host.harness.getExperimentalFeatures());
  const sessionlessV2 = session === undefined && host.engineV2;
  if (sessionlessV2) {
    // Session-less v2: rebuild the workspace-level dynamic commands too, so
    // skill/plugin changes apply before the first session exists.
    await host.refreshSkillCommands();
    await host.refreshPluginCommands();
  }
  host.refreshSlashCommandAutocomplete();
  applyRuntimeConfig(host, config);
  await applyReloadedTuiConfig(host, tuiConfig);

  if (session === undefined) {
    // Still session-less on the v2 engine: refresh the lazy defaults too, so
    // defaults edited externally (config.toml, a newly added default model)
    // reach the first lazy-created session instead of staying stale.
    if (sessionlessV2) {
      await host.hydrateLazyConfigDefaults();
    }
    host.showStatus(
      'Runtime and TUI config reloaded; no active session.',
      'success',
    );
  }
}

export async function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): Promise<void> {
  const resolved = config.theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    disablePasteBurst: config.disablePasteBurst,
    cacheExpiryHint: config.cacheExpiryHint,
    notifications: config.notifications,
    upgrade: config.upgrade,
    statusLine: config.statusLine,
  });
  host.state.editor.setDisablePasteBurst(config.disablePasteBurst);
}

function applyRuntimeConfig(host: SlashCommandHost, config: KimiConfig): void {
  host.setAppState({
    availableModels: config.models ?? {},
    availableProviders: config.providers ?? {},
  });
}
