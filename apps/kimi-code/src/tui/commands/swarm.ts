import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  SwarmStartPermissionPromptComponent,
  type SwarmStartPermissionChoice,
} from '../components/dialogs/swarm-start-permission-prompt';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export function handleSwarmCommand(host: SlashCommandHost, args: string): void {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  const prompt = args.trim();
  if (prompt.length === 0) {
    host.showError('Usage: /swarm <task>');
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showSwarmStartPermissionPrompt(host, prompt);
    return;
  }

  host.sendSwarmUserInput(prompt);
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
  host.sendSwarmUserInput(prompt);
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
