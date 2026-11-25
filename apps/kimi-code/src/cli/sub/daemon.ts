import chalk from 'chalk';
import type { Command } from 'commander';

import { darkColors } from '#/tui/theme/colors';
import { getDataDir } from '#/utils/paths';

import {
  getDaemonStatusSnapshot,
  isSharedDaemonSupported,
  restartSharedDaemon,
  stopSharedDaemon,
  type DaemonStatusSnapshot,
  type RunningDaemonInfo,
} from './web/daemon-client';

export interface DaemonCommandDeps {
  readonly homeDir?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly getStatus?: (homeDir: string) => Promise<DaemonStatusSnapshot>;
  readonly stopDaemon?: typeof stopSharedDaemon;
  readonly restartDaemon?: typeof restartSharedDaemon;
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_DAEMON_COMMAND_DEPS: DaemonCommandDeps = {
  homeDir: getDataDir,
  stdout: process.stdout,
  stderr: process.stderr,
};

function assertSupportedPlatform(deps: DaemonCommandDeps): void {
  if (!isSharedDaemonSupported(deps.platform ?? process.platform)) {
    throw new Error(
      "Kimi background daemon is not yet supported on Windows; run 'kimi web' or 'kimi rc' in the foreground.",
    );
  }
}

export function formatDaemonStatus(snapshot: DaemonStatusSnapshot): string {
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const ok = (text: string): string => chalk.hex(darkColors.success)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);

  if (!snapshot.running || snapshot.daemon === undefined) {
    const lines = [
      `${title('Kimi daemon')}  ${muted('stopped')}`,
      `  ${label('Remote Control: ')}${muted(snapshot.persistedRemoteControl ? 'off (saved: enabled on next start)' : 'off')}`,
      `  ${label('Logs:           ')}${snapshot.logPath}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  const d = snapshot.daemon;
  const rc = snapshot.remoteControl;
  const rcSummary =
    rc === undefined
      ? muted('unknown')
      : rc.enabled && rc.url !== undefined
        ? `${ok('on')}  ${accent(rc.url)}${rc.deviceName ? `  ${muted(`(${rc.deviceName})`)}` : ''}`
        : rc.state === 'starting'
          ? muted('starting…')
          : rc.error !== undefined
            ? `${muted('off')} (${rc.error})`
            : muted('off');

  const lines = [
    `${title('Kimi daemon')}  ${ok('running')}`,
    `  ${label('Version:         ')}${d.version} ${muted(`(KAP v${String(d.kapVersion)})`)}`,
    `  ${label('PID:             ')}${d.pid !== undefined ? String(d.pid) : muted('unknown')}`,
    `  ${label('Started:         ')}${d.startedAt || muted('unknown')}`,
    `  ${label('Listeners:       ')}${accent(d.origin)} ${muted('·')} unix:${d.socketPath}`,
    `  ${label('Remote Control:  ')}${rcSummary}`,
    `  ${label('Active sessions: ')}${String(snapshot.activeSessions.length)}`,
  ];
  for (const session of snapshot.activeSessions) {
    const summaryTitle = session.title.trim() || '(untitled)';
    lines.push(`    - ${session.id}  [${session.activity}]  ${summaryTitle}`);
  }
  lines.push(`  ${label('Logs:            ')}${snapshot.logPath}`);
  return `${lines.join('\n')}\n`;
}

function formatRestartSummary(daemon: RunningDaemonInfo): string {
  const pidPart = daemon.pid !== undefined ? ` (pid ${String(daemon.pid)})` : '';
  return `Kimi daemon ${daemon.version}${pidPart} listening on ${daemon.origin}.\n`;
}

export async function handleDaemonStatus(
  deps: DaemonCommandDeps = DEFAULT_DAEMON_COMMAND_DEPS,
): Promise<void> {
  assertSupportedPlatform(deps);
  const homeDir = (deps.homeDir ?? getDataDir)();
  const snapshot = await (deps.getStatus ?? getDaemonStatusSnapshot)(homeDir);
  deps.stdout.write(formatDaemonStatus(snapshot));
}

export async function handleDaemonStop(
  opts: { force?: boolean },
  deps: DaemonCommandDeps = DEFAULT_DAEMON_COMMAND_DEPS,
): Promise<void> {
  assertSupportedPlatform(deps);
  const homeDir = (deps.homeDir ?? getDataDir)();
  const result = await (deps.stopDaemon ?? stopSharedDaemon)({
    homeDir,
    force: opts.force === true,
  });
  if (result.outcome === 'not_running') {
    deps.stdout.write('Kimi daemon is not running.\n');
    return;
  }
  if (result.outcome === 'cancelled') {
    deps.stdout.write('Aborted; Kimi daemon is still running.\n');
    return;
  }
  const pidLabel = result.pid !== undefined ? ` (pid ${String(result.pid)})` : '';
  deps.stdout.write(`Kimi daemon${pidLabel} ${result.outcome}.\n`);
}

export async function handleDaemonRestart(
  opts: { force?: boolean },
  deps: DaemonCommandDeps = DEFAULT_DAEMON_COMMAND_DEPS,
): Promise<void> {
  assertSupportedPlatform(deps);
  const homeDir = (deps.homeDir ?? getDataDir)();
  const result = await (deps.restartDaemon ?? restartSharedDaemon)({
    homeDir,
    force: opts.force === true,
  });
  if (result.cancelled) {
    deps.stdout.write('Aborted; Kimi daemon was not restarted.\n');
    return;
  }
  deps.stdout.write(formatRestartSummary(result.daemon));
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Inspect or manage the shared background Kimi daemon.');

  daemon
    .command('status')
    .description('Show version, PID, listeners, Remote Control state, active sessions, and log path.')
    .action(async () => {
      try {
        await handleDaemonStatus();
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });

  daemon
    .command('stop')
    .description('Stop the background Kimi daemon.')
    .option('-f, --force', 'Stop without confirmation even if sessions are actively running.', false)
    .action(async (opts: { force?: boolean }) => {
      try {
        await handleDaemonStop(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });

  daemon
    .command('restart')
    .description('Restart the background Kimi daemon and restore persisted settings.')
    .option('-f, --force', 'Restart without confirmation even if sessions are actively running.', false)
    .action(async (opts: { force?: boolean }) => {
      try {
        await handleDaemonRestart(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
