import { ensureDaemon } from '#/cli/sub/server/daemon';
import { openUrl } from '#/utils/open-url';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const WEB_CONFIRM = 'confirm';
const WEB_CANCEL = 'cancel';

/**
 * `/web` — hand the current session off to the browser.
 *
 * Equivalent to `kimi server run` (ensures the background daemon is up) plus
 * `kimi web` (opens the browser), but deep-linked to the active session and
 * followed by shutting down this terminal UI. A confirmation step spells out
 * the consequences and only proceeds when the user presses Enter on Continue.
 */
export async function handleWebCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const sessionId = session.id;

  const confirmed = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Open current session in the Web UI?',
      hint: '↑↓ navigate · Enter select · Esc cancel',
      options: [
        {
          value: WEB_CONFIRM,
          label: 'Continue',
          description:
            'Start the Kimi server (background daemon if needed), open this session in your default browser, and exit the terminal UI.',
        },
        {
          value: WEB_CANCEL,
          label: 'Cancel',
          description: 'Stay in the terminal UI.',
        },
      ],
      onSelect: (value) => {
        resolve(value === WEB_CONFIRM);
      },
      onCancel: () => {
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
  host.restoreEditor();
  if (!confirmed) return;

  host.showStatus('Starting Kimi server and opening web UI…');
  let origin: string;
  try {
    ({ origin } = await ensureDaemon({}));
  } catch (error) {
    host.showError(`Failed to start server: ${formatErrorMessage(error)}`);
    return;
  }

  const url = webSessionUrl(origin, sessionId);
  openUrl(url);
  host.setExitOpenUrl(url);
  await host.stop();
}

/** Build the deep-link URL the web UI recognises for a session. */
export function webSessionUrl(origin: string, sessionId: string): string {
  return `${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
}
