/**
 * MonitorTool — run a self-filtering shell command in the background and
 * receive each new stdout line as a notification.
 */

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BackgroundManager } from '../../agent/background';
import type { BuiltinTool } from '../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../support/rule-match';
import MONITOR_DESCRIPTION from './monitor.md?raw';

export const MonitorInputSchema = z.object({
  command: z.string().describe('Shell command to monitor. Each stdout line is an event; self-filter (e.g. grep --line-buffered).'),
  description: z.string().describe('Short description shown in every notification.'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(3600000)
    .default(300000)
    .describe('Kill the monitor after this deadline. Ignored when persistent=true.'),
  persistent: z
    .boolean()
    .default(false)
    .describe('Run for the lifetime of the session (no timeout). Stop with TaskStop.'),
});

export type MonitorInput = z.Infer<typeof MonitorInputSchema>;

export class MonitorTool implements BuiltinTool<MonitorInput> {
  readonly name = 'Monitor' as const;
  readonly description = MONITOR_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorInputSchema);

  private readonly isWindowsBash: boolean;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    private readonly background: BackgroundManager,
  ) {
    this.isWindowsBash = this.kaos.osEnv.osKind === 'Windows';
  }

  resolveExecution(args: MonitorInput): ToolExecution {
    return {
      description: `Monitoring: ${args.command}`,
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: async (_ctx) => this.execution(args),
    };
  }

  private async execution(args: MonitorInput): Promise<ExecutableToolResult> {
    const effectiveCwd = this.cwd;
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;

    let proc: KaosProcess;
    try {
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    const timeoutMs = args.persistent ? undefined : args.timeout_ms;
    let taskId: string;
    try {
      taskId = this.background.registerMonitorTask(proc, command, args.description, {
        detached: true,
        timeoutMs,
      });
    } catch (error) {
      // Registration can throw (e.g. maxRunningTasks reached). The process is
      // already spawned and not yet owned by the manager, so clean it up here
      // to avoid orphaning a long-running command — mirrors the Bash path.
      await killSpawnedProcess(proc);
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      isError: false,
      message: 'Monitor started.',
      output:
        `task_id: ${taskId}\n` +
        `persistent: ${args.persistent}\n` +
        'Each matching stdout line arrives as a notification. Stop with TaskStop.',
    };
  }

  private spawn(effectiveCwd: string, command: string): Promise<KaosProcess> {
    const shellCwd = this.isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellArgs = [
      this.kaos.osEnv.shellPath,
      '-c',
      `cd ${shellQuote(shellCwd)} && ${command}`,
    ];

    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: this.kaos.osEnv.shellPath,
    };

    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...noninteractiveEnv,
    };
    return this.kaos.execWithEnv(shellArgs, mergedEnv);
  }
}

function closeProcessStdin(proc: KaosProcess): void {
  try {
    proc.stdin.end();
  } catch {
    /* process already gone */
  }
}

async function killSpawnedProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
    /* process already gone */
  } finally {
    try {
      await proc.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  return path.replaceAll('\\', '/');
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}
