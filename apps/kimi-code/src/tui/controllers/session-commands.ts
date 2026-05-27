import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './slash-commands';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession({ id: session.id, title: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const sourceTitle = forkSourceTitle(host, session);
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: session.id,
      title: `Fork: ${sourceTitle}`,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
    return;
  }

  try {
    await host.switchToSession(forked, `Session forked (${forked.id}).`);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch to forked session: ${msg}`);
  }
}

function forkSourceTitle(host: SlashCommandHost, session: Session): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

  const summaryTitle =
    typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
  return summaryTitle.length > 0 ? summaryTitle : session.id;
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await session.init();
    host.track('init_complete');
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Init failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}
