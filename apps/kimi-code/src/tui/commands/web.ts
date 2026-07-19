import chalk from 'chalk';

import { listLiveServerInstances, type ServerInstanceInfo } from '@moonshot-ai/kap-server';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/web/run';
import {
  instanceConnectHost,
  isServerHealthy,
  parseServerOptions,
  serverOrigin,
  tryResolveServerToken,
} from '#/cli/sub/web/shared';
import { getVersion } from '#/cli/version';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { darkColors } from '../theme/colors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/** Picker value of the "start a new server" row (instance rows carry their serverId). */
const NEW_SERVER_VALUE = '__new__';

/** How long to wait for the chosen server to answer `/healthz`. */
const HEALTH_TIMEOUT_MS = 1500;

/**
 * `/web` — hand the current session off to the browser.
 *
 * Lists the live server instances from the registry (with their versions) and
 * lets the user pick one to open the session on, or start a new server — the
 * new one runs in the foreground attached to this terminal after the TUI
 * exits, taking the next free port alongside the running ones. With no
 * instance running there is nothing to pick, so it starts a new server
 * directly. Either way the TUI shuts down once the session deep link is
 * opened.
 */
export async function handleWebCommand(
  host: SlashCommandHost,
  args = '',
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const sessionId = session.id;

  const instances = await listLiveServerInstances();
  if (instances.length === 0) {
    // Nothing to pick: become the server right away, no picker needed.
    startNewServerAfterExit(host, sessionId);
    await host.stop();
    return;
  }

  const options: ChoiceOption[] = instances.map((instance) => ({
    value: instance.serverId,
    label: serverOrigin(instanceConnectHost(instance), instance.port),
    description: instanceDescription(instance),
    descriptionTone:
      instance.hostVersion !== undefined && instance.hostVersion !== getVersion()
        ? 'warning'
        : undefined,
  }));
  options.push({
    value: NEW_SERVER_VALUE,
    label: 'Start a new server',
    description:
      'Run a new server in the foreground on this terminal after the TUI exits (stop with Ctrl+C), then open the session deep link in your browser.',
  });

  const chosen = await new Promise<string | undefined>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Open current session in the Web UI?',
      options,
      onSelect: (value) => {
        resolve(value);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
  host.restoreEditor();
  if (chosen === undefined) return;

  if (chosen === NEW_SERVER_VALUE) {
    startNewServerAfterExit(host, sessionId);
    await host.stop();
    return;
  }

  const instance = instances.find((entry) => entry.serverId === chosen);
  if (instance === undefined) return;
  const origin = serverOrigin(instanceConnectHost(instance), instance.port);
  if (!(await isServerHealthy(origin, HEALTH_TIMEOUT_MS))) {
    host.showError(`Kimi server at ${origin} is not responding.`);
    return;
  }

  // Resolve the persistent token so the opened browser auto-authenticates via
  // the `#token=` fragment — matching the `kimi web` command. Show the URL
  // and token in green under the status line so they can be copied before the
  // terminal exits. Best-effort: an older/never-started server has no token
  // file, so we fall back to the plain URL and skip the token line.
  const token = tryResolveServerToken(getDataDir());
  const url = webSessionUrl(origin, sessionId, token);
  host.showStatus(`open ${url}`, 'success');
  if (token !== undefined) {
    host.showStatus(`Token:    ${token}`, 'success');
  }
  openUrl(url);
  host.setExitOpenUrl(url);
  await host.stop();
}

/** `version X · id Y` for the picker row; flags a CLI/server mismatch for the warning tone. */
function instanceDescription(instance: ServerInstanceInfo): string {
  if (instance.hostVersion === undefined) {
    return `version unknown (registered by an older build) · id ${instance.serverId}`;
  }
  if (instance.hostVersion !== getVersion()) {
    return `version ${instance.hostVersion} (this CLI: ${getVersion()}) · id ${instance.serverId}`;
  }
  return `version ${instance.hostVersion} · id ${instance.serverId}`;
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
          process.stdout.write(formatReadyBanner(origin, options.host, { token, foreground: true }));
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
