import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { getShellPathBridge } from '#/_base/execEnv/shellPathBridge';

export function spawnShellCommand(
  processService: IHostProcessService,
  env: HostEnvironmentInfo,
  effectiveCwd: string,
  command: string,
): Promise<IHostProcess> {
  const shellCwd = getShellPathBridge(env).toShellPath(effectiveCwd);
  const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
  const noninteractiveEnv: Record<string, string> = {
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
    SHELL: env.shellPath,
  };

  return processService.spawn(env.shellPath, ['-c', shellCommand], { env: noninteractiveEnv });
}

export function shellCommandFor(env: HostEnvironmentInfo, command: string): string {
  return env.osKind === 'Windows' ? rewriteWindowsNullRedirect(command) : command;
}

export function closeProcessStdin(proc: IHostProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

export async function killSpawnedProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    try {
      await proc.dispose();
    } catch {
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}
