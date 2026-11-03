import type { SessionEnvironmentDir } from '@moonshot-ai/kimi-code-sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { slashBusyMessage, slashCommandBusyReason } from './resolve';

type AddDirChoice = 'session' | 'remember' | 'cancel';

const MULTI_ENVIRONMENT_FLAG = 'multi_environment';
const CANCEL_ENVIRONMENT = '';

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  let session = host.session;

  if (input.length === 0 || input.toLowerCase() === 'list') {
    // With no session yet (v2 session-less startup) the pending startup
    // directories live in appState and will be passed to the lazy-created
    // session; reflect them instead of reporting an empty list.
    const additionalDirs = session?.summary?.additionalDirs ?? host.state.appState.additionalDirs;
    const environmentDirs = session?.summary?.environmentDirs ?? [];
    if (additionalDirs.length === 0 && environmentDirs.length === 0) {
      host.showStatus('No additional directories configured.');
      return;
    }
    host.showStatus(formatAdditionalDirsStatus(additionalDirs, environmentDirs));
    return;
  }

  if (session === undefined) {
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

  const sessionId = session.id;
  const environments = await otherEnvironments(session);
  if (environments === undefined) {
    showPersistChoice(host, sessionId, input, undefined);
    return;
  }
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Add directory: ${input}`,
      hint: '↑↓ navigate · Enter confirm · Esc cancel',
      options: [
        { value: environments.primary, label: `${environments.primary} (this session's environment)` },
        ...environments.others.map((environmentId) => ({ value: environmentId, label: environmentId })),
        { value: CANCEL_ENVIRONMENT, label: 'Cancel' },
      ],
      onSelect: (value) => {
        if (value === CANCEL_ENVIRONMENT) {
          host.restoreEditor();
          host.showStatus(`Did not add ${input} as a working directory.`);
          return;
        }
        showPersistChoice(host, sessionId, input, value === environments.primary ? undefined : value);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(`Did not add ${input} as a working directory.`);
      },
    }),
  );
}

async function otherEnvironments(
  session: NonNullable<SlashCommandHost['session']>,
): Promise<{ readonly primary: string; readonly others: readonly string[] } | undefined> {
  if (!isExperimentalFlagEnabled(MULTI_ENVIRONMENT_FLAG)) return undefined;
  try {
    const [binding, { environments }] = await Promise.all([session.getEnvironment(), session.listEnvironments()]);
    const others = environments
      .map((environment) => environment.environmentId)
      .filter((environmentId) => environmentId !== binding.environmentId);
    return others.length === 0 ? undefined : { primary: binding.environmentId, others };
  } catch {
    return undefined;
  }
}

function showPersistChoice(
  host: SlashCommandHost,
  sessionId: string,
  input: string,
  environmentId: string | undefined,
): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title:
        environmentId === undefined
          ? `Add directory to workspace: ${input}`
          : `Mount directory on ${environmentId}: ${input}`,
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
        void handleAddDirChoice(host, sessionId, input, value as AddDirChoice, environmentId);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus(`Did not add ${input} as a working directory.`);
      },
    }),
  );
}

function formatAdditionalDirsStatus(
  additionalDirs: readonly string[],
  environmentDirs: readonly SessionEnvironmentDir[],
): string {
  return [
    ...(additionalDirs.length === 0 ? [] : ['Additional directories:', ...additionalDirs.map((dir) => `  ${dir}`)]),
    ...(environmentDirs.length === 0
      ? []
      : ['Environment directories:', ...environmentDirs.map((dir) => `  ${dir.environmentId}: ${dir.path}`)]),
  ].join('\n');
}

async function handleAddDirChoice(
  host: SlashCommandHost,
  sessionId: string,
  path: string,
  choice: AddDirChoice,
  environmentId: string | undefined,
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
    if (environmentId !== undefined) {
      await session.addAdditionalDir(path, { persist: choice === 'remember', environmentId });
      host.showStatus(
        choice === 'remember'
          ? `Mounted directory on ${environmentId}:\n  ${path}\n  Remembered in the workspace registry`
          : `Mounted directory on ${environmentId}:\n  ${path}\n  For this session only`,
        'success',
      );
      return;
    }
    const result = await session.addAdditionalDir(path, { persist: choice === 'remember' });
    host.setAppState({ additionalDirs: result.additionalDirs });
    host.refreshSlashCommandAutocomplete();
    host.showStatus(
      choice === 'remember'
        ? `Added workspace directory:\n  ${path}\n  Remembered in the workspace registry`
        : `Added workspace directory:\n  ${path}\n  For this session only`,
      'success',
    );
  } catch (error) {
    host.showError(error instanceof Error ? error.message : String(error));
  }
}
