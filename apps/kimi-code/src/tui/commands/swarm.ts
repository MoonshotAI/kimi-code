import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  SwarmStartPermissionPromptComponent,
  type SwarmStartPermissionChoice,
} from '../components/dialogs/swarm-start-permission-prompt';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { isExperimentalFlagEnabled } from './experimental-flags';

type SwarmModeKind = 'standard' | 'ultra';
type SwarmModeEntry = 'manual' | 'task' | 'ultra' | 'ultra_task';

const ULTRA_SWARM_FLAG = 'ultra_swarm';
const ULTRA_SWARM_DISABLED_MESSAGE =
  'Ultra swarm is experimental. Enable it in /experiments or set KIMI_CODE_EXPERIMENTAL_ULTRA_SWARM=1.';

export async function handleSwarmCommand(host: SlashCommandHost, args: string): Promise<void> {
  const prompt = args.trim();
  const ultraArgs = parseSwarmUltraArgs(prompt);
  if (ultraArgs !== undefined) {
    if (!isUltraSwarmEnabled(host)) return;
    await handleSwarmModeRequest(host, ultraArgs, 'ultra', commandText('/swarm', prompt));
    return;
  }
  await handleSwarmModeRequest(host, prompt, 'standard', commandText('/swarm', prompt));
}

export async function handleUltraModeCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (!isUltraSwarmEnabled(host)) return;
  const prompt = args.trim();
  await handleSwarmModeRequest(host, prompt, 'ultra', commandText('/ultramode', prompt));
}

async function handleSwarmModeRequest(
  host: SlashCommandHost,
  prompt: string,
  mode: SwarmModeKind,
  inputText: string,
): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const enabled = swarmModeSubcommand(prompt);
  if (enabled !== undefined) {
    await applySwarmMode(host, enabled, inputText, mode);
    return;
  }

  if (prompt.length === 0) {
    await applySwarmMode(host, toggledSwarmEnabled(host, mode), inputText, mode);
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(host, inputText, 'Swarm task not started.', (choice) =>
      startSwarmWithPermission(host, prompt, choice, mode),
    );
    return;
  }

  await startSwarmTask(host, prompt, mode);
}

function showSwarmStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: SwarmStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  host.mountEditorReplacement(
    new SwarmStartPermissionPromptComponent({
      onSelect: (choice) => {
        host.restoreEditor();
        void onSelect(choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startSwarmWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: SwarmStartPermissionChoice,
  mode: SwarmModeKind,
): Promise<void> {
  if (choice === 'auto') {
    if (!(await setPermissionForSwarm(host, choice))) return;
  }
  await startSwarmTask(host, prompt, mode);
}

async function setPermissionForSwarm(host: SlashCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startSwarmTask(
  host: SlashCommandHost,
  prompt: string,
  mode: SwarmModeKind,
): Promise<void> {
  if (!(await ensureSwarmMode(host, mode, 'task'))) {
    return;
  }
  renderSwarmModeMarker(host, markerForMode(mode));
  host.sendNormalUserInput(prompt);
}

async function applySwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
  mode: SwarmModeKind,
): Promise<void> {
  if (enabled && host.state.appState.swarmMode) {
    if (mode === 'ultra' && !isUltraSwarmEntry(host.state.swarmModeEntry)) {
      if (!(await ensureSwarmMode(host, mode, 'manual'))) return;
      renderSwarmModeMarker(host, markerForMode(mode));
      return;
    }
    host.showStatus('Swarm mode is already on.');
    return;
  }
  if (!enabled && !host.state.appState.swarmMode) {
    host.showStatus('Swarm mode is already off.');
    return;
  }
  if (!enabled && mode === 'ultra' && !isUltraSwarmEntry(host.state.swarmModeEntry)) {
    host.showStatus('Ultra swarm mode is already off.');
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(host, commandText, 'Swarm mode not enabled.', async (choice) => {
      if (choice === 'auto' && !(await setPermissionForSwarm(host, choice))) return;
      if (!(await ensureSwarmMode(host, mode, 'manual'))) return;
      renderSwarmModeMarker(host, markerForMode(mode));
    });
    return;
  }
  if (enabled) {
    if (!(await ensureSwarmMode(host, mode, 'manual'))) return;
    renderSwarmModeMarker(host, markerForMode(mode));
    return;
  }
  if (!(await setSwarmMode(host, false, 'manual'))) return;
  renderSwarmModeMarker(host, 'inactive');
}

async function setSwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: SwarmModeEntry,
  options: { readonly restoreEntry?: 'manual' | 'ultra' } = {},
): Promise<boolean> {
  try {
    await host.requireSession().setSwarmMode(enabled, trigger);
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} swarm mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ swarmMode: enabled });
  host.state.swarmModeEntry = enabled ? trigger : undefined;
  host.state.swarmModeRestoreEntry = enabled ? options.restoreEntry : undefined;
  return true;
}

async function ensureSwarmMode(
  host: SlashCommandHost,
  mode: SwarmModeKind,
  triggerKind: 'manual' | 'task',
): Promise<boolean> {
  const trigger = triggerForMode(mode, triggerKind);
  if (!host.state.appState.swarmMode) {
    return setSwarmMode(host, true, trigger);
  }
  if (mode !== 'ultra' || isUltraSwarmEntry(host.state.swarmModeEntry)) {
    return true;
  }
  const restoreEntry =
    triggerKind === 'task' && host.state.swarmModeEntry === 'manual'
      ? host.state.swarmModeEntry
      : undefined;
  if (!(await setSwarmMode(host, false, 'manual'))) return false;
  return setSwarmMode(host, true, trigger, { restoreEntry });
}

function swarmModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function parseSwarmUltraArgs(input: string): string | undefined {
  if (input.toLowerCase() === 'ultra') return '';
  const match = /^ultra\s+([\s\S]*)$/i.exec(input);
  return match?.[1]?.trim();
}

function isUltraSwarmEnabled(host: SlashCommandHost): boolean {
  if (isExperimentalFlagEnabled(ULTRA_SWARM_FLAG)) return true;
  host.showError(ULTRA_SWARM_DISABLED_MESSAGE);
  return false;
}

function toggledSwarmEnabled(host: SlashCommandHost, mode: SwarmModeKind): boolean {
  if (mode === 'ultra') {
    return !(host.state.appState.swarmMode && isUltraSwarmEntry(host.state.swarmModeEntry));
  }
  return !host.state.appState.swarmMode;
}

function triggerForMode(mode: SwarmModeKind, triggerKind: 'manual' | 'task'): SwarmModeEntry {
  if (mode === 'ultra') return triggerKind === 'manual' ? 'ultra' : 'ultra_task';
  return triggerKind;
}

function isUltraSwarmEntry(entry: unknown): boolean {
  return entry === 'ultra' || entry === 'ultra_task';
}

function markerForMode(mode: SwarmModeKind): SwarmModeMarkerState {
  return mode === 'ultra' ? 'ultra-active' : 'active';
}

function commandText(command: '/swarm' | '/ultramode', args: string): string {
  return args.length === 0 ? command : `${command} ${args}`;
}

function renderSwarmModeMarker(host: SlashCommandHost, state: SwarmModeMarkerState): void {
  host.state.transcriptContainer.addChild(
    new SwarmModeMarkerComponent(state),
  );
  host.state.ui.requestRender();
}
