import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import { getVersion } from '#/cli/version';
import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT } from '#/constant/app';
import {
  buildRemoteControlUrl,
  formatRemoteControlAlreadyRunning,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  inspectRemoteControlLock,
  startRemoteControl,
  type RemoteControlStatus,
} from '#/cli/sub/web/remote-control';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/web/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/web/shared';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { persistedKimiOAuthRef } from '#/utils/region';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

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
    const options = parseServerOptions({});
    let remoteControl: Awaited<ReturnType<typeof startRemoteControl>> | undefined;
    try {
      await startServerForeground(options, {
        onReady: async (origin, controls) => {
          const dataDir = getDataDir();
          const token = tryResolveServerToken(dataDir);
          if (token === undefined) throw new Error('Unable to read the local server token.');
          const persisted = persistedKimiOAuthRef();
          let outputReady = false;
          const pendingStatuses: string[] = [];
          const onStatus = (status: RemoteControlStatus): void => {
            const line = formatRemoteControlStatus(status);
            if (outputReady) process.stdout.write(line);
            else pendingStatuses.push(line);
          };
          remoteControl = await startRemoteControl({
            homeDir: dataDir,
            localOrigin: origin,
            localServerToken: token,
            clientVersion: `${CLI_USER_AGENT_PRODUCT}/${getVersion()}`,
            urlSource: CLI_MSH_PLATFORM,
            configuredOAuthKey: persisted?.key,
            configuredOAuthHost: persisted?.oauthHost,
            onStatus,
          });
          void remoteControl.closed.then(
            (reason) => {
              if (reason === 'user_requested') {
                controls?.requestShutdown('remote_control_user_requested');
              }
            },
            (error) => {
              process.stderr.write(
                `Remote Control lock release failed: ${formatErrorMessage(error)}\n`,
              );
              controls?.requestShutdown('remote_control_closed');
            },
          );
          const url = buildRemoteControlUrl(
            remoteControl.deviceId,
            session?.id,
            remoteControl.relayOrigin,
            CLI_MSH_PLATFORM,
          );
          const qrCode = await generateRemoteControlQr(url, dataDir);
          process.stdout.write(
            formatRemoteControlOutput({
              url,
              localOrigin: origin,
              localServerToken: token,
              deviceName: remoteControl.deviceName,
              qrCode: qrCode.terminal,
              pngPath: qrCode.pngPath,
            }),
          );
          outputReady = true;
          for (const line of pendingStatuses) process.stdout.write(line);
          openUrl(url);
        },
        onShutdown: async () => {
          await remoteControl?.close();
        },
      });
    } catch (error) {
      process.stderr.write(`Failed to start Remote Control: ${formatErrorMessage(error)}\n`);
      process.exit(1);
    }
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
