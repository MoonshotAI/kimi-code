import { WelcomeComponent } from '../components/chrome/welcome';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { UserMessageComponent } from '../components/messages/user-message';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { TranscriptEntry } from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Undo command
// ---------------------------------------------------------------------------

export async function handleUndoCommand(host: SlashCommandHost): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot undo while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const entries = host.state.transcriptEntries;
  const lastUserIndex = entries.findLastIndex(isUndoAnchorEntry);
  if (lastUserIndex < 0) {
    host.showError('Nothing to undo.');
    return;
  }

  try {
    await session.undoHistory(1);
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(`Failed to undo: ${message}`);
    return;
  }

  const children = host.state.transcriptContainer.children;
  let lastUserComponentIndex = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (
      child instanceof UserMessageComponent ||
      (child instanceof SkillActivationComponent && child.trigger === 'user-slash')
    ) {
      lastUserComponentIndex = i;
      break;
    }
  }

  if (lastUserComponentIndex >= 0) {
    removeUndoContextComponents(children, lastUserComponentIndex);
    host.state.transcriptContainer.invalidate();
  }

  const preservedEntries = entries.slice(lastUserIndex).filter(
    (entry) => !isUndoContextEntry(entry),
  );
  entries.splice(lastUserIndex, entries.length - lastUserIndex, ...preservedEntries);

  if (entries.length === 0) {
    renderWelcome(host);
  }

  host.state.ui.requestRender();
}

function isUndoAnchorEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === 'user' ||
    (entry.kind === 'skill_activation' && entry.skillTrigger === 'user-slash')
  );
}

function isUndoContextEntry(entry: TranscriptEntry): boolean {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'thinking':
    case 'skill_activation':
    case 'cron':
      return true;
    case 'status':
    case 'welcome':
      return false;
  }
}

function removeUndoContextComponents(
  children: SlashCommandHost['state']['transcriptContainer']['children'],
  startIndex: number,
): void {
  for (let i = children.length - 1; i >= startIndex; i--) {
    const child = children[i];
    if (child !== undefined && isUndoContextComponent(child)) {
      children.splice(i, 1);
    }
  }
}

function isUndoContextComponent(
  child: SlashCommandHost['state']['transcriptContainer']['children'][number],
): boolean {
  return (
    child instanceof UserMessageComponent ||
    child instanceof AssistantMessageComponent ||
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof AgentGroupComponent ||
    child instanceof ReadGroupComponent ||
    child instanceof SkillActivationComponent ||
    child instanceof BackgroundAgentStatusComponent ||
    child instanceof CronMessageComponent
  );
}

function renderWelcome(host: SlashCommandHost): void {
  if (
    host.state.transcriptContainer.children.some(
      (child) => child instanceof WelcomeComponent,
    )
  ) {
    return;
  }
  host.state.transcriptContainer.addChild(
    new WelcomeComponent(host.state.appState, host.state.theme.colors),
  );
}
