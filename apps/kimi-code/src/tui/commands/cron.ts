import type { CronTaskSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { CronSelectorComponent } from '../components/dialogs/cron-selector';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/cron` — lists the session's scheduled cron tasks and lets the user
 * delete one (with an inline confirmation in the selector). Closes the
 * selector after a deletion; run `/cron` again to keep pruning.
 */
export async function handleCronCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError('No active session.');
    return;
  }

  let tasks: readonly CronTaskSnapshot[];
  try {
    tasks = (await session.getCronTasks()).tasks;
  } catch (error) {
    host.showError(`Failed to load cron tasks: ${formatErrorMessage(error)}`);
    return;
  }

  if (tasks.length === 0) {
    host.showStatus('No scheduled cron tasks.');
    return;
  }

  host.mountEditorReplacement(
    new CronSelectorComponent({
      tasks,
      onDelete: (task) => {
        void deleteCronTask(host, task);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function deleteCronTask(host: SlashCommandHost, task: CronTaskSnapshot): Promise<void> {
  host.restoreEditor();
  const session = host.session;
  if (session === undefined) {
    host.showError('No active session.');
    return;
  }
  try {
    const { deleted } = await session.deleteCronTask(task.id);
    host.showStatus(
      deleted
        ? `Deleted cron task ${task.id} (${task.cron}).`
        : `Cron task ${task.id} was already gone.`,
      deleted ? 'success' : 'warning',
    );
  } catch (error) {
    host.showError(`Failed to delete cron task ${task.id}: ${formatErrorMessage(error)}`);
  }
}
