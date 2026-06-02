import { WelcomeComponent } from '../components/chrome/welcome';
import { SkillActivationComponent } from '../components/messages/skill-activation';
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
    children.splice(lastUserComponentIndex);
    host.state.transcriptContainer.invalidate();
  }

  entries.splice(lastUserIndex);

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
