import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import {
  DEFAULT_REMOTE_CONTROL_RUN_DEPS,
  formatRemoteControlAlreadyRunning,
  inspectRemoteControlLock,
  runRemoteControl,
} from '#/cli/sub/web/remote-control';
import {
  attachRemoteControlServer,
  formatReadyBanner,
  startServerForeground,
} from '#/cli/sub/web/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/web/shared';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { darkColors } from '../theme/colors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleWebCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  startNewServerAfterExit(host, session.id);
  await host.stop();
}

export async function handleRemoteControlCommand(host: SlashCommandHost): Promise<void> {
  await host.waitForSessionAssembly();
  const session = host.session;

  const holder = await inspectRemoteControlLock(getDataDir());
  if (holder !== undefined) {
    host.showError(formatRemoteControlAlreadyRunning(holder));
    return;
  }

  host.setExitForegroundTask(async () => {
    try {
      await runRemoteControl(
        { open: true, sessionId: session?.id },
        {
          ...DEFAULT_REMOTE_CONTROL_RUN_DEPS,
          attachServer: () => attachRemoteControlServer(parseServerOptions({})),
        },
      );
    } catch (error) {
      process.stderr.write(`Remote Control failed: ${formatErrorMessage(error)}\n`);
      process.exit(1);
    }
    process.exit(0);
  });
  await host.stop();
}

function startNewServerAfterExit(host: SlashCommandHost, sessionId: string): void {
  host.setExitForegroundTask(async () => {
    const options = parseServerOptions({});
    try {
      await startServerForeground(options, {
        onReady: (origin) => {
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

function sessionLine(url: string, labelText = 'Session:  '): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const [base, frag] = splitTokenFragment(url);
  return `${label(labelText)}${accent(base)}${frag === '' ? '' : dim(frag)}`;
}

export function webSessionUrl(origin: string, sessionId: string, token?: string): string {
  const base = `${origin.replace(/\/+$/, '')}/sessions/${encodeURIComponent(sessionId)}`;
  return token === undefined ? base : `${base}#token=${token}`;
}
