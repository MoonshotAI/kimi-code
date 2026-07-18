import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/server/access-urls';
import { ensureDaemon, findReusableDaemon } from '#/cli/sub/server/daemon';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/server/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/server/shared';
import { getVersion } from '#/cli/version';
import { darkColors } from '#/tui/theme/colors';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { t } from '#/i18n';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { getNoActiveSessionMessage } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const WEB_CONFIRM = 'confirm';
const WEB_CANCEL = 'cancel';
const WEB_BACKGROUND_FLAG = '--background';

/**
 * `/web` — hand the current session off to the browser.
 *
 * Default (foreground): the TUI shuts down and the Kimi server takes over this
 * terminal in the foreground (`Ctrl+C` stops it), with the browser opened to
 * the active session. `/web --background` instead ensures the background
 * daemon is up, opens the browser, and releases the terminal — equivalent to
 * `kimi web --background`. A server that is already running is reused in both
 * modes. A confirmation step spells out the consequences and only proceeds
 * when the user presses Enter on Continue.
 */
export async function handleWebCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }
  const sessionId = session.id;
  const background = args.split(/\s+/).includes(WEB_BACKGROUND_FLAG);

  const confirmed = await new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: t('tui.statusMessages.openInWebUi'),
      hint: t('tui.statusMessages.openInWebUiHint'),
      options: [
        {
          value: WEB_CONFIRM,
          label: t('tui.statusMessages.continueLabel'),
          description: background
            ? 'Start the Kimi server (background daemon if needed), open this session in your default browser, and exit the terminal UI.'
            : 'Start the Kimi server in the foreground (this terminal stays attached; Ctrl+C stops it), open this session in your default browser, and exit the terminal UI.',
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

  if (background) {
    let origin: string;
    let hostVersion: string | undefined;
    try {
      ({ origin, hostVersion } = await ensureDaemon({}));
    } catch (error) {
      host.showError(`Failed to start server: ${formatErrorMessage(error)}`);
      return;
    }
    // Resolve the persistent token only after the daemon is up: a fresh server
    // writes `server.token` on first boot, so reading it beforehand would miss
    // first-time starts and the browser would hit the auth gate. Best-effort:
    // fall back to the plain URL (and skip the token line) when unresolvable.
    showServerVersionHint(host, hostVersion);
    await openAndExit(host, sessionId, origin, tryResolveServerToken(getDataDir()));
    return;
  }

  // Foreground by default. A server that is already running can serve the web
  // UI right away — reuse it instead of failing to bind its port.
  let reused: { origin: string; hostVersion?: string } | undefined;
  try {
    reused = await findReusableDaemon();
  } catch (error) {
    host.showError(`Failed to probe the running server: ${formatErrorMessage(error)}`);
    return;
  }
  if (reused !== undefined) {
    showServerVersionHint(host, reused.hostVersion);
    await openAndExit(host, sessionId, reused.origin, tryResolveServerToken(getDataDir()));
    return;
  }

  // No server is running: shut the TUI down and let the Kimi server take over
  // this terminal in the foreground (the registered task runs after teardown,
  // where `process.exit` would normally happen). The deep link is opened from
  // the ready hook, once the server is actually listening, and the terminal
  // shows the same ready banner as `kimi web` plus the session deep link.
  host.setExitForegroundTask(async () => {
    const runOptions = { ...parseServerOptions({}), keepAlive: true };
    try {
      await startServerForeground(runOptions, {
        onReady: (origin) => {
          // Resolve the token here (after the server is listening) for the
          // same first-boot reason as the daemon path above.
          const token = tryResolveServerToken(getDataDir());
          const url = webSessionUrl(origin, sessionId, token);
          process.stdout.write(
            formatReadyBanner(origin, runOptions.host, { token, foreground: true }),
          );
          process.stdout.write(`\n  ${sessionLine(url)}\n`);
          openUrl(url);
        },
      });
    } catch (error) {
      process.stderr.write(t('tui.statusMessages.failedToStartServer', { error: formatErrorMessage(error) }) + '\n');
      process.exit(1);
    }
  });
  await host.stop();
}

/** Styled `Session:` line for the foreground handoff; the token fragment is
 * dimmed like in the ready banner so the host/path stands out. */
function sessionLine(url: string): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const [base, frag] = splitTokenFragment(url);
  return `${label('Session:  ')}${accent(base)}${frag === '' ? '' : dim(frag)}`;
}

/**
 * Warn when the reused server was started by a different CLI version: it keeps
 * serving its own bundled web UI/API until restarted. Mirrors the banner hint
 * printed by `kimi web`.
 */
function showServerVersionHint(host: SlashCommandHost, hostVersion: string | undefined): void {
  if (hostVersion === undefined || hostVersion === getVersion()) return;
  host.showStatus(
    `Running server is version ${hostVersion}, this CLI is ${getVersion()} — restart with kimi server kill to pick up the new version.`,
    'warning',
  );
}

/**
 * Open the session deep link in the browser, record it for the exit hints,
 * and shut the TUI down. Used when the server is already running out of
 * process (reused or freshly-spawned daemon), so exit frees the terminal.
 */
function openAndExit(
  host: SlashCommandHost,
  sessionId: string,
  origin: string,
  token: string | undefined,
): Promise<void> {
  const url = webSessionUrl(origin, sessionId, token);
  host.showStatus(t('tui.statusMessages.webOpenUrl', { url }), 'success');
  if (token !== undefined) {
    host.showStatus(t('tui.statusMessages.webToken', { token }), 'success');
  }
  openUrl(url);
  host.setExitOpenUrl(url);
  return host.stop();
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
