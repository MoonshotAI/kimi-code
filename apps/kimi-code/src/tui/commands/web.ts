import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/web/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/web/shared';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { darkColors } from '../theme/colors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/web` — hand the current session off to the browser.
 *
 * Always starts a new server: the TUI shuts down and this process becomes the
 * server, running in the foreground attached to this terminal and taking the
 * next free port alongside any running ones. The session deep link opens from
 * the ready hook once the server is actually listening.
 */
export async function handleWebCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  startNewServerAfterExit(host, session.id);
  await host.stop();
}

/**
 * Register the exit takeover that turns this process into the new server once
 * the TUI has shut down (where `process.exit` would normally happen): the
 * server stays attached to this terminal until Ctrl+C, and the session deep
 * link opens from the ready hook once the server is actually listening. The
 * terminal shows the same ready banner as `kimi web` plus the deep link.
 */
function startNewServerAfterExit(host: SlashCommandHost, sessionId: string): void {
  host.setExitForegroundTask(async () => {
    const options = parseServerOptions({});
    try {
      await startServerForeground(options, {
        onReady: (origin) => {
          // Resolve the token here (after the server is listening): a fresh
          // server writes `server.token` on first boot, so reading it earlier
          // would miss first-time starts and the browser would hit the auth
          // gate.
          const token = tryResolveServerToken(getDataDir());
          const url = webSessionUrl(origin, sessionId, token);
          process.stdout.write(formatReadyBanner(origin, options.host, { token }));
          process.stdout.write(`\n  ${sessionLine(url)}\n`);
          openUrl(url);
        },
      });
    } catch (error) {
      process.stderr.write(`Failed to start server: ${formatErrorMessage(error)}\n`);
      process.exit(1);
    }
  });
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
 * Build the deep-link URL the web UI recognises for a session. When a token is
 * known it rides in the `#token=` fragment (never sent to the server, so never
 * logged), so the browser authenticates on load just like `kimi web`.
 */
export function webSessionUrl(origin: string, sessionId: string, token?: string): string {
  const base = `${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
  return token === undefined ? base : `${base}#token=${token}`;
}
