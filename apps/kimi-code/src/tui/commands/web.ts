import chalk from 'chalk';

import { splitTokenFragment } from '#/cli/sub/web/access-urls';
import {
  enableDaemonRemoteControl,
  ensureSharedDaemon,
  isSharedDaemonSupported,
} from '#/cli/sub/web/daemon-client';
import {
  buildRemoteControlUrl,
  formatRemoteControlAlreadyRunning,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  inspectRemoteControlLock,
  RemoteControlAlreadyRunningError,
  startRemoteControl,
  type RemoteControlStatus,
} from '#/cli/sub/web/remote-control';
import { formatReadyBanner, startServerForeground } from '#/cli/sub/web/run';
import { parseServerOptions, tryResolveServerToken } from '#/cli/sub/web/shared';
import { getVersion } from '#/cli/version';
import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT } from '#/constant/app';
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

  if (!isSharedDaemonSupported()) {
    startNewServerAfterExit(host, session.id);
    await host.stop();
    return;
  }

  const dataDir = getDataDir();
  let daemonResult: Awaited<ReturnType<typeof ensureSharedDaemon>>;
  try {
    daemonResult = await ensureSharedDaemon({ homeDir: dataDir });
  } catch (error) {
    host.showError(`Failed to start Kimi daemon: ${formatErrorMessage(error)}`);
    return;
  }

  const { daemon, reusedBusyMismatch } = daemonResult;
  const sessionId = session.id;
  host.setExitForegroundTask(async () => {
    if (reusedBusyMismatch) {
      process.stderr.write(
        `Note: Kimi daemon ${daemon.version} has active work; continuing with the running daemon.\n`,
      );
    }
    const token = tryResolveServerToken(dataDir);
    const url = webSessionUrl(daemon.origin, sessionId, token);
    process.stdout.write(
      formatReadyBanner(daemon.origin, daemon.host, {
        token,
        logPath: daemon.logPath,
        stopCommand: 'kimi daemon stop',
      }),
    );
    process.stdout.write(`\n  ${sessionLine(url)}\n`);
    openUrl(url);
  });
  await host.stop();
}

export async function handleRemoteControlCommand(host: SlashCommandHost): Promise<void> {
  await host.waitForSessionAssembly();
  const session = host.session;
  const dataDir = getDataDir();

  if (!isSharedDaemonSupported()) {
    const holder = await inspectRemoteControlLock(dataDir);
    if (holder !== undefined) {
      host.showError(formatRemoteControlAlreadyRunning(holder));
      return;
    }
    startForegroundRemoteControlAfterExit(host, session?.id);
    await host.stop();
    return;
  }

  let daemonResult: Awaited<ReturnType<typeof ensureSharedDaemon>>;
  try {
    daemonResult = await ensureSharedDaemon({ homeDir: dataDir });
  } catch (error) {
    host.showError(`Failed to start Kimi daemon: ${formatErrorMessage(error)}`);
    return;
  }

  const token = tryResolveServerToken(dataDir);
  if (token === undefined) {
    host.showError('Unable to read the local server token.');
    return;
  }

  let rc: Awaited<ReturnType<typeof enableDaemonRemoteControl>>;
  try {
    rc = await enableDaemonRemoteControl(daemonResult.daemon.socketPath);
  } catch (error) {
    if (error instanceof RemoteControlAlreadyRunningError) {
      host.showError(formatRemoteControlAlreadyRunning(error.holder));
      return;
    }
    host.showError(`Failed to start Remote Control: ${formatErrorMessage(error)}`);
    return;
  }

  const { daemon, reusedBusyMismatch } = daemonResult;
  const sessionId = session?.id;
  host.setExitForegroundTask(async () => {
    if (reusedBusyMismatch) {
      process.stderr.write(
        `Note: Kimi daemon ${daemon.version} has active work; continuing with the running daemon.\n`,
      );
    }
    const url = buildRemoteControlUrl(rc.deviceId, sessionId, rc.relayOrigin, CLI_MSH_PLATFORM);
    const qrCode = await generateRemoteControlQr(url, dataDir);
    process.stdout.write(
      formatRemoteControlOutput({
        url,
        localOrigin: daemon.origin,
        localServerToken: token,
        deviceName: rc.deviceName,
        qrCode: qrCode.terminal,
        pngPath: qrCode.pngPath,
        logPath: daemon.logPath,
        stopCommand: 'kimi rc stop',
      }),
    );
    openUrl(url);
  });
  await host.stop();
}

function startForegroundRemoteControlAfterExit(
  host: SlashCommandHost,
  sessionId: string | undefined,
): void {
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
            sessionId,
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
