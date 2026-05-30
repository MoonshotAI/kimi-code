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
  // Show the readable command in the transcript before the turn starts. The
  // prompt actually sent to the model is the verbose buildSwarmPrompt wrapper,
  // so without this the live transcript would show a Swarm tool card with no
  // preceding user request.
  host.appendUserTranscriptEntry(`/swarm ${task}`);
  // Route through the same session-request lifecycle as a normal send /
  // skill activation rather than calling session.prompt raw. beginSessionRequest
  // flips streamingPhase out of 'idle' synchronously, so the input gate closes
  // immediately and shows the waiting pane; otherwise, during the window before
  // turn.started arrives the UI still thinks it is idle and a fast follow-up
  // message could be dispatched as a second concurrent prompt and be silently
  // dropped as agent_busy.
  host.beginSessionRequest();
  try {
    await session.prompt(buildSwarmPrompt(task));
  } catch (error) {
    host.failSessionRequest(`Failed to start swarm: ${formatErrorMessage(error)}`);
  }
}
