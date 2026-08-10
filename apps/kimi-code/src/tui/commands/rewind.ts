import { join } from 'node:path';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { UndoSelectorComponent } from '../components/dialogs/undo-selector';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { WorkspaceChange, WorkspaceRewindPlan } from '../workspace-checkpoints';
import type { SlashCommandHost } from './dispatch';
import {
  createUndoChoices,
  parseUndoCount,
  resolveUndoAvailability,
  undoByCount,
} from './undo';

export async function handleRewindCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot rewind while streaming — press Esc or Ctrl-C first.');
    return;
  }
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const store = host.getWorkspaceCheckpointStore?.();
  if (store === undefined) {
    host.showError('Workspace rewind is unavailable because this session has no local checkpoint store.');
    return;
  }

  const availability = await resolveUndoAvailability(host);
  const checkpointCount = await store.availableCount();
  const maxCount = Math.min(availability.maxCount, checkpointCount);
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    const choices = createUndoChoices(
      host.state.transcriptEntries,
      host.state.transcriptContainer.children,
      maxCount,
    );
    if (choices.length === 0) {
      host.showStatus(checkpointCount === 0 ? 'No workspace checkpoints to rewind.' : 'Nothing to rewind.');
      return;
    }
    host.mountEditorReplacement(
      new UndoSelectorComponent({
        title: 'Select messages and files to rewind',
        choices,
        onSelect: (choice) => {
          void rewindByCount(host, choice.count, true).then((rewound) => {
            if (rewound) host.restoreInputText(choice.input);
          });
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
    return;
  }

  const count = parseUndoCount(trimmed);
  if (count === undefined) {
    host.showError('Usage: /rewind [count], where count is a positive integer.');
    return;
  }
  if (count > maxCount) {
    host.showError(
      `Cannot rewind ${formatPromptCount(count)}; only ${formatPromptCount(maxCount)} have both conversation history and workspace checkpoints.`,
    );
    return;
  }
  await rewindByCount(host, count, false);
}

async function rewindByCount(
  host: SlashCommandHost,
  count: number,
  editorIsReplaced: boolean,
): Promise<boolean> {
  const store = host.getWorkspaceCheckpointStore?.();
  if (store === undefined) {
    if (editorIsReplaced) host.restoreEditor();
    host.showError('Workspace rewind is unavailable for this session.');
    return false;
  }

  let plan: WorkspaceRewindPlan;
  try {
    plan = await store.prepareRewind(count);
  } catch (error) {
    if (editorIsReplaced) host.restoreEditor();
    host.showError(`Cannot prepare rewind: ${formatErrorMessage(error)}`);
    return false;
  }

  const confirmed = await confirmRewind(host, plan);
  if (!confirmed) {
    await store.releasePreview().catch(() => undefined);
    return false;
  }

  try {
    await store.apply(plan);
  } catch (error) {
    await store.releasePreview().catch(() => undefined);
    host.showError(`Rewind aborted before conversation history changed: ${formatErrorMessage(error)}`);
    return false;
  }

  const conversationUndone = await undoByCount(host, count, {
    preserveWorkspaceCheckpoints: true,
  });
  if (!conversationUndone) {
    try {
      await store.rollback(plan);
    } catch (error) {
      host.showError(
        `Conversation rewind failed and workspace rollback also failed: ${formatErrorMessage(error)}`,
      );
      return false;
    }
    await store.releasePreview().catch(() => undefined);
    host.showStatus(
      'Conversation rewind failed; workspace files were restored to their pre-rewind state.',
      'warning',
    );
    return false;
  }

  try {
    await store.commit(plan);
  } catch (error) {
    // The user-visible rewind already succeeded. Invalidate stale metadata so
    // a later command cannot apply checkpoints against the wrong turn suffix.
    await store.invalidate().catch(() => undefined);
    host.showStatus(
      `Rewind completed, but its checkpoint metadata could not be finalized: ${formatErrorMessage(error)}`,
      'warning',
    );
    return true;
  }

  host.showStatus(
    `Rewound ${formatPromptCount(count)} and ${formatFileCount(plan.changes.length)}.`,
    'success',
  );
  return true;
}

function confirmRewind(host: SlashCommandHost, plan: WorkspaceRewindPlan): Promise<boolean> {
  const summary = summarizeChanges(plan.changes);
  return new Promise((resolveConfirmed) => {
    let completed = false;
    const finish = (confirmed: boolean): void => {
      if (completed) return;
      completed = true;
      host.restoreEditor();
      resolveConfirmed(confirmed);
    };
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: `Rewind ${formatPromptCount(plan.count)} and workspace files?`,
        hint: 'Review the workspace changes below · Enter/Space select · Esc cancel',
        notice: summary.notice,
        noticeTone: plan.changes.length === 0 ? 'success' : 'warning',
        currentValue: 'cancel',
        options: [
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Leave conversation history and workspace files unchanged.',
          },
          {
            value: 'rewind',
            label: 'Rewind conversation and files',
            tone: 'danger',
            description: summary.description,
          },
        ],
        onSelect: (value) => {
          finish(value === 'rewind');
        },
        onCancel: () => {
          finish(false);
        },
      }),
    );
  });
}

function summarizeChanges(changes: readonly WorkspaceChange[]): {
  readonly notice: string;
  readonly description: string;
} {
  const created = changes.filter((change) => change.kind === 'created').length;
  const modified = changes.filter((change) => change.kind === 'modified').length;
  const deleted = changes.filter((change) => change.kind === 'deleted').length;
  if (changes.length === 0) {
    return {
      notice: 'No tracked workspace files changed; only conversation history will be rewound.',
      description: 'Withdraw the selected prompts from the active context.',
    };
  }
  const preview = changes.slice(0, 8).map((change) => {
    const action = change.kind === 'created' ? 'delete' : change.kind === 'deleted' ? 'restore' : 'restore';
    return `${action.padEnd(7)} ${displayWorkspacePath(change)}`;
  });
  if (changes.length > preview.length) preview.push(`…and ${changes.length - preview.length} more`);
  return {
    notice: [`Workspace delta: ${created} created, ${modified} modified, ${deleted} deleted.`, ...preview].join('\n'),
    description: `Restore ${formatFileCount(changes.length)} to the state before the selected prompts. Files ignored by .gitignore/.ignore, dependency trees, VCS metadata, and symlinks are outside the checkpoint.`,
  };
}

function displayWorkspacePath(change: WorkspaceChange): string {
  return JSON.stringify(join(change.root, change.path));
}

function formatPromptCount(count: number): string {
  return `${count} ${count === 1 ? 'prompt' : 'prompts'}`;
}

function formatFileCount(count: number): string {
  return `${count} workspace ${count === 1 ? 'file' : 'files'}`;
}
