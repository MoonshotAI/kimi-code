import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import { i18n, resolveLocale } from '#/tui/i18n';
import { currentTheme, lightColors } from '#/tui/theme';
import { loadTuiConfig, type TuiConfig } from '../config';
import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';

export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  const tuiConfig = await loadTuiConfig();
  await applyReloadedTuiConfig(host, tuiConfig);
  host.showStatus('TUI config reloaded.', 'success');
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
  applyRuntimeConfig(host, config);
  // applyReloadedTuiConfig rebuilds the slash-command autocomplete, picking up
  // both the refreshed experimental-flag gating above and the reloaded locale.
  await applyReloadedTuiConfig(host, tuiConfig);

  if (session === undefined) {
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
  // Re-apply the language alongside the theme: update the persisted preference
  // in app state and flip the live i18n locale so a reloaded `language` takes
  // effect without a process restart.
  i18n.setLocale(resolveLocale(config.language));
  // Rebuild the `/` autocomplete snapshot so its localized command descriptions
  // follow the reloaded locale. `/reload` already refreshes it separately, but
  // `/reload-tui` reaches this helper directly, so refresh here too.
  host.refreshSlashCommandAutocomplete();
  host.setAppState({
    editorCommand: config.editorCommand,
    notifications: config.notifications,
    upgrade: config.upgrade,
    language: config.language,
  });
}

function applyRuntimeConfig(host: SlashCommandHost, config: KimiConfig): void {
  host.setAppState({
    availableModels: config.models ?? {},
    availableProviders: config.providers ?? {},
  });
}
