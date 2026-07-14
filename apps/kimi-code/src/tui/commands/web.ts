import { ensureDaemon } from '#/cli/sub/server/daemon';
import { tryResolveServerToken } from '#/cli/sub/server/shared';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { t } from '#/i18n';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { getNoActiveSessionMessage } from '../constant/kimi-tui';
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
    host.showError(getNoActiveSessionMessage());
    return;
  }
  const sessionId = session.id;

  const confirmed = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('tui.statusMessages.openInWebUi'),
      hint: t('tui.statusMessages.openInWebUiHint'),
      options: [
        {
          value: WEB_CONFIRM,
          label: t('tui.statusMessages.continueLabel'),
          description:
            t('tui.statusMessages.continueDescription'),
        },
        {
          value: WEB_CANCEL,
          label: t('tui.statusMessages.cancelLabel'),
          description: t('tui.statusMessages.stayInTui'),
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

  host.showStatus(t('tui.statusMessages.startingServerAndWebUi'));
  let origin: string;
  try {
    ({ origin } = await ensureDaemon({}));
  } catch (error) {
    host.showError(t('tui.statusMessages.failedToStartServer', { error: formatErrorMessage(error) }));
    return;
  }

  // Resolve the persistent token so the opened browser auto-authenticates via
  // the `#token=` fragment — matching the `kimi web` subcommand. Show the URL
  // and token in green under the status line so they can be copied before the
  // terminal exits. Best-effort: an older/never-started server has no token
  // file, so we fall back to the plain URL and skip the token line.
  const token = tryResolveServerToken(getDataDir());
  const url = webSessionUrl(origin, sessionId, token);
  host.showStatus(t('tui.statusMessages.webOpenUrl', { url }), 'success');
  if (token !== undefined) {
    host.showStatus(t('tui.statusMessages.webToken', { token }), 'success');
  }
  openUrl(url);
  host.setExitOpenUrl(url);
  await host.stop();
}

/**
 * Build the deep-link URL the web UI recognises for a session. When a token is
 * known it rides in the `#token=` fragment (never sent to the server, so never
 * logged), so the browser authenticates on load just like `kimi web`.
 */
export function webSessionUrl(origin: string, sessionId: string, token?: string): string {
  const base = `${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
  return token === undefined ? base : `${base}#token=${token}`;
}
