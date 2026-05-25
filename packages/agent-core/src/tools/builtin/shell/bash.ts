/**
 * BashTool — execute shell commands.
 *
 * Invokes bash (POSIX) according to an injected `Environment`. On Windows
 * the shell is Git Bash; the path is resolved by `detectEnvironment`.
 *
 * Dependencies injected via constructor:
 *   - `Kaos`        — shell execution abstraction (exec / execWithEnv)
 *   - `cwd`         — default working directory for commands
 *   - `Environment` — cross-platform probe (shellName / shellPath)
 *   - `BackgroundProcessManager?` — optional: required iff run_in_background=true
 *
 * Execution goes through Kaos, never directly via node:child_process.
 *
 * Hardening:
 *   - `args.timeout` (seconds) and the ambient `signal` both drive
 *     `Promise.race`; fire-a-kill on either edge.
 *   - stdin is closed immediately so interactive commands (`cat`, `read`,
 *     `python -c 'input()'`) receive EOF instead of hanging.
 *   - Two-phase kill: SIGTERM → 5s grace → SIGKILL (Kaos honours this
 *     contract cross-platform).
 *   - stdout/stderr stream into ToolResultBuilder; excess is replaced with a
 *     truncation marker so a runaway command cannot OOM the host.
 */

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { Environment } from '../../../utils/environment';
import { renderPrompt } from '../../../utils/render-prompt';
import type { BackgroundProcessManager } from '../../background/manager';
import { toInputJsonSchema } from '../../support/input-schema';
import { ToolResultBuilder } from '../../support/result-builder';
import bashDescriptionTemplate from './bash.md';

const MS_PER_SECOND = 1000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 5 * 60;
const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;
const SIGTERM_GRACE_MS = 5_000;

export const BashInputSchema = z
  .object({
    command: z.string().min(1, 'Command cannot be empty.').describe('The command to execute.'),
    cwd: z
      .string()
      .optional()
      .describe(
        "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUT_S)
      .describe(
        `Optional timeout in seconds for the command to execute. Foreground default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s. Background default ${String(DEFAULT_BACKGROUND_TIMEOUT_S)}s, max ${String(MAX_BACKGROUND_TIMEOUT_S)}s. Ignored for background commands when disable_timeout=true.`,
      )
      .optional(),
    description: z
      .string()
      .optional()
      .describe(
        'A short description for the background task. Required when run_in_background is true.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Whether to run the command as a background task.'),
    disable_timeout: z
      .boolean()
      .optional()
      .describe(
        'If true, do not apply a timeout to the command. Only applies when run_in_background is true.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.timeout === undefined) return;
    const isBackground = val.run_in_background === true;
    if (!isValidTimeoutValue(val.timeout, isBackground)) {
      const cap = isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeout'],
        message: `timeout must be ≤ ${String(cap)}s (${isBackground ? 'background' : 'foreground'})`,
      });
    }
  });

export const BashOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type BashInput = z.Infer<typeof BashInputSchema>;
export type BashOutput = z.Infer<typeof BashOutputSchema>;

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function isValidTimeoutValue(timeout: number, isBackground: boolean): boolean {
  return timeout <= timeoutCapS(isBackground);
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return description
    .replace(
      /\n\nIf `run_in_background=true`,[\s\S]*?point them to the `\/tasks` command, which opens an interactive panel; it has no subcommands\./,
      '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
    )
    .replace(
      ` For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s.`,
      ` For possibly long-running commands, set the \`timeout\` argument in seconds. The default is ${String(DEFAULT_TIMEOUT_S)}s; foreground commands allow up to ${String(MAX_TIMEOUT_S)}s.`,
    )
    .replace(
      /\n- Prefer `run_in_background=true`[\s\S]*?conversation to continue before the command finishes\./,
      '\n- Do not set `run_in_background=true`; background task management tools are not available.',
    );
}

export class BashTool implements BuiltinTool<BashInput> {
  readonly name = 'Bash' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  private readonly isWindowsBash: boolean;

  private readonly allowBackground: boolean;

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
    private readonly environment: Environment,
    private readonly backgroundManager?: BackgroundProcessManager,
    options?: {
      allowBackground?: boolean | undefined;
    },
  ) {
    this.isWindowsBash = this.environment.osKind === 'Windows';
    this.allowBackground = options?.allowBackground ?? this.backgroundManager !== undefined;
    const rendered = renderBashDescription(this.environment.shellName);
    this.description = this.allowBackground ? rendered : withoutBackgroundDescription(rendered);
  }

  resolveExecution(args: BashInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      execute: ({ signal }) => this.execution(args, signal),
    };
  }

  private spawn(effectiveCwd: string, command: string): Promise<KaosProcess> {
    const shellCwd = this.isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellArgs = [
      this.environment.shellPath,
      '-c',
      `cd ${shellQuote(shellCwd)} && ${command}`,
    ];

    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      // Default to '0' so git fails fast on private remotes if a TTY happens
      // to be inherited; honour an explicit ambient value when the user has
      // set one.
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: this.environment.shellPath,
    };

    // Merge ambient env + noninteractive knobs so tools like git / node
    // don't open a pager and paints don't colour the stream.
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...noninteractiveEnv,
    };
    return this.kaos.execWithEnv(shellArgs, mergedEnv);
  }

  private async execution(args: BashInput, signal: AbortSignal): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before command started' };
    }
    if (args.command.length === 0) {
      return { isError: true, output: 'Command cannot be empty.' };
    }

    if (args.run_in_background) {
      if (!this.allowBackground) {
        return {
          isError: true,
          output:
            'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
        };
      }
      return this.executeInBackground(args);
    }

    const timeoutMs = normalizeTimeoutMs(args.timeout, false);

    let proc: KaosProcess;
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      // Closing stdin on a process that has already exited is a no-op on
      // some platforms and throws on others — either is safe to ignore.
    }

    let timedOut = false;
    let aborted = false;
    let killed = false;

    const killProc = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* process already gone */
      }
      const exited = proc
        .wait()
        .then(() => true)
        .catch(() => true);
      const raced = await Promise.race([
        exited,
        new Promise<false>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, SIGTERM_GRACE_MS);
        }),
      ]);
      if (!raced && proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }

      try {
        proc.stdout.destroy();
      } catch {
        /* ignore */
      }
      try {
        proc.stderr.destroy();
      } catch {
        /* ignore */
      }
    };

    const onAbort = (): void => {
      aborted = true;
      void killProc();
    };
    signal.addEventListener('abort', onAbort);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, timeoutMs);

    try {
      const builder = new ToolResultBuilder();
      const [, exitCode] = await Promise.all([
        Promise.all([
          readStreamIntoBuilder(proc.stdout, builder),
          readStreamIntoBuilder(proc.stderr, builder),
        ]),
        proc.wait(),
      ]);

      if (timedOut) {
        const timeoutLabel =
          timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
        return builder.error(`Command killed by timeout (${timeoutLabel})`, {
          brief: `Killed by timeout (${timeoutLabel})`,
        });
      }
      if (aborted) {
        return builder.error('Interrupted by user', { brief: 'Interrupted by user' });
      }

      const isError = exitCode !== 0;
      if (isError && builder.nChars === 0) {
        builder.write(`Process exited with code ${String(exitCode)}`);
      }

      if (!isError) {
        return builder.ok('Command executed successfully.');
      }
      return builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async executeInBackground(args: BashInput): Promise<ExecutableToolResult> {
    if (!this.backgroundManager) {
      return {
        isError: true,
        output: 'Background execution is not available (no BackgroundProcessManager configured).',
      };
    }
    const backgroundManager = this.backgroundManager;

    if (!args.description?.trim()) {
      return {
        isError: true,
        output: 'description is required when run_in_background is true.',
      };
    }

    let reservation: ReturnType<BackgroundProcessManager['reserveSlot']>;
    try {
      reservation = backgroundManager.reserveSlot();
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    const timeoutMs = args.disable_timeout ? undefined : normalizeTimeoutMs(args.timeout, true);

    let proc: KaosProcess;
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;
    try {
      const effectiveCwd = args.cwd ?? this.cwd;
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      reservation.release();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      /* process already gone */
    }

    let taskId: string;
    try {
      taskId = backgroundManager.register(proc, command, args.description.trim(), {
        reservation,
        shellInfo: {
          shellName: this.environment.shellName,
          shellPath: this.environment.shellPath,
          cwd: args.cwd ?? this.cwd,
        },
      });
    } catch (error) {
      reservation.release();
      try {
        await proc.kill('SIGTERM');
      } catch {
        /* process already gone */
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (timeoutMs !== undefined) {
      setTimeout(() => {
        void (async (): Promise<void> => {
          if (proc.exitCode !== null) {
            await backgroundManager.settlePendingExits();
            return;
          }
          const info = backgroundManager.getTask(taskId);
          if (info && info.status === 'running') {
            void backgroundManager.stop(taskId);
          }
        })();
      }, timeoutMs);
    }

    // register() synchronously inserts taskId into the manager's Map, so
    // this lookup in the same tick cannot return undefined.
    const status = backgroundManager.getTask(taskId)!.status;
    const builder = new ToolResultBuilder();
    builder.write(
      `task_id: ${taskId}\n` +
        `pid: ${String(proc.pid)}\n` +
        `description: ${args.description.trim()}\n` +
        `status: ${status}\n` +
        `automatic_notification: true\n` +
        'next_step: You will be automatically notified when it completes.\n' +
        'next_step: Use TaskOutput with this task_id for a non-blocking status/output snapshot.\n' +
        'next_step: Use TaskStop only if the task must be cancelled.\n' +
        'human_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.',
    );
    return builder.ok('Background task started', { brief: `Started ${taskId}` });
  }
}

async function readStreamIntoBuilder(
  stream: Readable,
  builder: ToolResultBuilder,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    builder.write(decoder.write(buf));
  }
  builder.write(decoder.end());
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
