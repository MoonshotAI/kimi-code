import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';
import { TuiAltScreen } from '@moonshot-ai/pi-tui';

import { currentTheme, lightColors } from '#/tui/theme';
import {
  DEFAULT_MARKDOWN_CONFIG,
  loadTuiConfig,
  resolveTuiMode,
  resolveWheelScrollLines,
  type TuiConfig,
} from '../config';
import { TUI_MODE_SWITCH_BLOCKED_NOTICE } from '../constant/kimi-tui';
import { setMarkdownMermaidMode, setMarkdownRenderLatex } from '../utils/markdown-options';
import type { SlashCommandHost } from './dispatch';
import { applyTranscriptPresentation, tuiModeOverrideNotice } from './config';
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
    const reloadedSession = await host.harness.reloadSession({
      id: session.id,
      forcePluginSessionStartReminder: true,
    });
    await host.reloadCurrentSessionView(reloadedSession, 'Session reloaded.');
  }

  const config = await host.harness.getConfig({ reload: true });
  setExperimentalFeatures(await host.harness.getExperimentalFeatures());
  if (session === undefined) {
    await host.refreshSkillCommands();
    await host.refreshPluginCommands();
  }
  host.refreshSlashCommandAutocomplete();
  applyRuntimeConfig(host, config);
  host.setAppState({
    disableFeedbackSurvey: config.disableFeedbackSurvey ?? tuiConfig.disableFeedbackSurvey,
  });
  await applyReloadedTuiConfig(host, tuiConfig);

  if (session === undefined) {
    await host.hydrateLazyConfigDefaults();
    host.showStatus(
      'Environment and TUI config reloaded; no active session.',
      'success',
    );
  }
}

export async function applyReloadedTuiConfig(
  host: SlashCommandHost,
  config: TuiConfig,
): Promise<void> {
  setMarkdownRenderLatex(config.renderLatex ?? true);
  setMarkdownMermaidMode(config.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid);
  const resolved = config.theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(config.theme, resolved);
  host.refreshTerminalThemeTracking();
  host.setAppState({
    editorCommand: config.editorCommand,
    tuiMode: config.tuiMode,
    disablePasteBurst: config.disablePasteBurst,
    copyOnSelect: config.copyOnSelect,
    wheelScrollLines: config.wheelScrollLines,
    renderLatex: config.renderLatex,
    cacheExpiryHint: config.cacheExpiryHint,
    autoSessionTitle: config.autoSessionTitle,
    followUpBehavior: config.followUpBehavior,
    notifications: config.notifications,
    upgrade: config.upgrade,
    statusLine: config.statusLine,
    markdown: config.markdown,
    transcript: config.transcript,
  });
  host.state.editor.setDisablePasteBurst(config.disablePasteBurst);
  const applyNonSwitchedUpdates = (): void => {
    applyTranscriptPresentation(host);
    if (host.state.ui instanceof TuiAltScreen) {
      host.state.ui.setCopyOnSelect(config.copyOnSelect !== false);
      host.state.ui.setWheelScrollLines(resolveWheelScrollLines(config.wheelScrollLines));
    }
  };
  const resolution = resolveTuiMode(config.tuiMode);
  const overrideNotice = tuiModeOverrideNotice(resolution, config.tuiMode, 'reload');
  if (overrideNotice !== undefined) {
    applyNonSwitchedUpdates();
    host.showNotice(overrideNotice);
    return;
  }
  const switchResult = host.switchTuiMode(resolution.mode);
  if (switchResult.status !== 'switched') {
    applyNonSwitchedUpdates();
  }
  if (switchResult.status === 'blocked') {
    host.showNotice(TUI_MODE_SWITCH_BLOCKED_NOTICE);
  }
}

function applyRuntimeConfig(host: SlashCommandHost, config: KimiConfig): void {
  host.setAppState({
    availableModels: config.models ?? {},
    availableProviders: config.providers ?? {},
  });
}
