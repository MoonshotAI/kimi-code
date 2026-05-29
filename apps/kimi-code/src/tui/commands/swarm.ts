import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export function buildSwarmPrompt(task: string): string {
  return [
    'Use the Swarm tool to accomplish the following task.',
    'Call the Swarm tool exactly once with this task as its `task` argument; do not do the work yourself.',
    '',
    'Task:',
    task,
  ].join('\n');
}

export async function handleSwarmCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const task = args.trim();
  if (task.length === 0) {
    host.showError('Usage: /swarm <task>');
    return;
  }
  try {
    await session.prompt(buildSwarmPrompt(task));
  } catch (error) {
    host.showError(`Failed to start swarm: ${formatErrorMessage(error)}`);
  }
}
