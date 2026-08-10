import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';
import { slashBusyMessage, slashCommandBusyReason } from './resolve';

type RemoveDirChoice = 'session' | 'forget' | 'cancel';

export async function handleRemoveDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  if (input.length > 0) {
    await showRemovalScopePicker(host, input);
    return;
  }

  const additionalDirs = host.session?.summary?.additionalDirs ?? host.state.appState.additionalDirs;
  if (additionalDirs.length === 0) {
    host.showStatus('No additional directories configured.');
    return;
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Remove an additional workspace directory',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: additionalDirs.map((dir) => ({ value: dir, label: dir })),
      onSelect: (value) => {
        void showRemovalScopePicker(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus('Did not remove a working directory.');
      },
    }),
  );
}

async function showRemovalScopePicker(host: SlashCommandHost, path: string): Promise<void> {
  let session = host.session;
  if (session === undefined) {
    if (!host.engineV2) {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    session = await host.ensureSession();
    if (session === undefined) return;
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (busyReason !== undefined) {
      host.showError(slashBusyMessage('remove-dir', busyReason));
      return;
    }
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Remove directory from workspace: ${path}`,
      hint: '↑↓ navigate · Enter confirm · Esc cancel',
      options: [
        { value: 'session', label: 'Remove session-only directory' },
        { value: 'forget', label: 'Remove and forget for this project' },
        { value: 'cancel', label: 'Cancel' },
      ],
      onSelect: (value) => {
        void handleRemoveDirChoice(host, session.id, path, value as RemoveDirChoice);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(`Did not remove ${path} as a working directory.`);
      },
    }),
  );
}

async function handleRemoveDirChoice(
  host: SlashCommandHost,
  sessionId: string,
  path: string,
  choice: RemoveDirChoice,
): Promise<void> {
  host.restoreEditor();
  if (choice === 'cancel') {
    host.showStatus(`Did not remove ${path} as a working directory.`);
    return;
  }

  const session = host.session;
  if (session === undefined || session.id !== sessionId) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const result = await session.removeAdditionalDir(path, { forget: choice === 'forget' });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      result.forgotten
        ? `Removed workspace directory:\n  ${path}\n  Removed from:\n  ${result.configPath}`
        : `Removed workspace directory:\n  ${path}\n  For this session only`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
