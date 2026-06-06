import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  SwarmStartPermissionPromptComponent,
  type SwarmStartPermissionChoice,
} from '../components/dialogs/swarm-start-permission-prompt';
import { SwarmModeMarkerComponent } from '../components/messages/swarm-markers';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleSwarmCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const prompt = args.trim();
  const mode = swarmModeSubcommand(prompt);
  if (mode !== undefined) {
    await applySwarmMode(host, mode);
    return;
  }

  if (prompt.length === 0) {
    await applySwarmMode(host, !host.state.appState.swarmMode);
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    if (!(await activateSwarmForTask(host))) return;
    showSwarmStartPermissionPrompt(host, prompt);
    return;
  }

  await startSwarmTask(host, prompt);
}

function showSwarmStartPermissionPrompt(host: SlashCommandHost, prompt: string): void {
  const commandText = `/swarm ${prompt}`;
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus('Swarm task not started.');
  };
  host.mountEditorReplacement(
    new SwarmStartPermissionPromptComponent({
      colors: host.state.theme.colors,
      onSelect: (choice) => {
        if (choice === 'cancel') {
          cancelStart();
          return;
        }
        host.restoreEditor();
        void startSwarmWithPermission(host, prompt, choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startSwarmWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: SwarmStartPermissionChoice,
): Promise<void> {
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForSwarm(host, choice))) return;
  }
  host.sendNormalUserInput(prompt);
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

async function startSwarmTask(host: SlashCommandHost, prompt: string): Promise<void> {
  if (!(await activateSwarmForTask(host))) return;
  host.sendNormalUserInput(prompt);
}

async function activateSwarmForTask(host: SlashCommandHost): Promise<boolean> {
  if (!host.state.appState.swarmMode && !(await setSwarmMode(host, true, 'task'))) {
    return false;
  }
  renderSwarmModeMarker(host, true);
  return true;
}

async function applySwarmMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  if (enabled && host.state.appState.swarmMode) {
    host.showStatus('Swarm mode is already on.');
    return;
  }
  if (!enabled && !host.state.appState.swarmMode) {
    host.showStatus('Swarm mode is already off.');
    return;
  }
  if (!(await setSwarmMode(host, enabled, 'manual'))) return;
  renderSwarmModeMarker(host, enabled);
}

async function setSwarmMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: 'manual' | 'task',
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
  return true;
}

function swarmModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderSwarmModeMarker(host: SlashCommandHost, active: boolean): void {
  host.state.transcriptContainer.addChild(
    new SwarmModeMarkerComponent(active, host.state.theme.colors),
  );
  host.state.ui.requestRender();
}
