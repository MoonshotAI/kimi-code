import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { slashBusyMessage, slashCommandBusyReason } from './resolve';

type AddDirChoice = 'session' | 'remember' | 'cancel';

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  let session = host.session;

  if (input.length === 0 || input.toLowerCase() === 'list') {
    // With no session yet (v2 session-less startup) the pending startup
    // directories live in appState and will be passed to the lazy-created
    // session; reflect them instead of reporting an empty list.
    const additionalDirs = session?.summary?.additionalDirs ?? host.state.appState.additionalDirs;
    if (additionalDirs.length === 0) {
      host.showStatus('No additional directories configured.');
      return;
    }
    host.showStatus(formatAdditionalDirsStatus(additionalDirs));
    return;
  }

  if (session === undefined) {
    if (!host.engineV2) {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    // The path-adding form needs a live session; lazy-create it on first use
    // (the read-only `list`/bare forms above tolerate a missing session).
    session = await host.ensureSession();
    if (session === undefined) return;
    // A first prompt may have started a turn during the await; /add-dir is
    // idle-only, so re-check the busy gate resolved before it.
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (busyReason !== undefined) {
      host.showError(slashBusyMessage('add-dir', busyReason));
      return;
    }
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Add directory to workspace: ${input}`,
      hint: '↑↓ navigate · Enter confirm · Esc cancel',
      options: [
        {
          value: 'session',
          label: 'Yes, for this session',
        },
        {
          value: 'remember',
          label: 'Yes, and remember this directory',
        },
        {
          value: 'cancel',
          label: 'No',
        },
      ],
      onSelect: (value) => {
        void handleAddDirChoice(host, session.id, input, value as AddDirChoice);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(`Did not add ${input} as a working directory.`);
      },
    }),
  );
}

function formatAdditionalDirsStatus(additionalDirs: readonly string[]): string {
  return ['Additional directories:', ...additionalDirs.map((dir) => `  ${dir}`)].join('\n');
}

async function handleAddDirChoice(
  host: SlashCommandHost,
  sessionId: string,
  path: string,
  choice: AddDirChoice,
): Promise<void> {
  host.restoreEditor();

  if (choice === 'cancel') {
    host.showStatus(`Did not add ${path} as a working directory.`);
    return;
  }

  const session = host.session;
  if (session === undefined || session.id !== sessionId) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  try {
    const result = await session.addAdditionalDir(path, { persist: choice === 'remember' });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      choice === 'remember'
        ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${result.configPath}`
        : `Added workspace directory:\n  ${path}\n  For this session only`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
