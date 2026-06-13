/**
 * PowerShellTool — execute PowerShell commands on Windows.
 *
 * Mirrors BashTool's foreground contract but targets powershell.exe so the
 * model can run Windows-native commands when Git Bash is not the right fit.
 */

import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '#/agent/tool';
import type { ExecutableToolResult, ToolExecution, ToolUpdate } from '#/loop/types';
import { toInputJsonSchema } from '#/tools/support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tools/support/rule-match';
import { ToolResultBuilder } from '#/tools/support/result-builder';
import DESCRIPTION from './powershell.md?raw';

const MS_PER_SECOND = 1000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 5 * 60;
const SIGTERM_GRACE_MS = 5_000;

export const PowerShellInputSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty.').describe('The PowerShell command to execute.'),
  cwd: z
    .string()
    .optional()
    .describe("The working directory in which to run the command. When omitted, the command runs in the session's working directory."),
  timeout: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_TIMEOUT_S)
    .describe(
      `Optional timeout in seconds for the command to execute. Default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s.`,
    )
    .optional(),
});

export type PowerShellInput = z.infer<typeof PowerShellInputSchema>;

export class PowerShellTool implements BuiltinTool<PowerShellInput> {
  readonly name = 'PowerShell' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(PowerShellInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly cwd: string,
  ) {}

  resolveExecution(args: PowerShellInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: `Running PowerShell: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.cwd,
        language: 'powershell',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, onUpdate }) => this.execution(args, signal, onUpdate),
    };
  }

  private spawn(effectiveCwd: string, command: string): Promise<KaosProcess> {
    // Prefer powershell.exe on Windows; pwsh (PowerShell Core) elsewhere if present.
    const shell = this.kaos.osEnv.osKind === 'Windows' ? 'powershell.exe' : 'pwsh';
    const isWindowsPowerShell = shell === 'powershell.exe';

    // powershell.exe does not support -WorkingDirectory; change directory inline.
    const commandWithCwd = isWindowsPowerShell
      ? `Set-Location -Path '${effectiveCwd.replace(/'/g, "''")}'; ${command}`
      : command;

    const args = [
      shell,
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      ...(isWindowsPowerShell ? [] : ['-WorkingDirectory', effectiveCwd]),
      '-Command',
      commandWithCwd,
    ];
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
    };
    const mergedEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...noninteractiveEnv,
    };
    return this.kaos.execWithEnv(args, mergedEnv);
  }

  private async execution(
    args: PowerShellInput,
    signal: AbortSignal,
    onUpdate?: ((update: ToolUpdate) => void) | undefined,
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before command started' };
    }
    if (args.command.length === 0) {
      return { isError: true, output: 'Command cannot be empty.' };
    }

    const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * MS_PER_SECOND;
    const effectiveCwd = args.cwd ?? this.cwd;

    let proc: KaosProcess;
    try {
      proc = await this.spawn(effectiveCwd, args.command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      proc.stdin.end();
    } catch {
      // process may have already exited
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
      } catch {}
      try {
        proc.stderr.destroy();
      } catch {}
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
      const isTerminating = (): boolean => timedOut || aborted || killed;
      const [, exitCode] = await Promise.all([
        Promise.all([
          readStreamIntoBuilder(proc.stdout, builder, 'stdout', onUpdate, isTerminating),
          readStreamIntoBuilder(proc.stderr, builder, 'stderr', onUpdate, isTerminating),
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
}

async function readStreamIntoBuilder(
  stream: Readable,
  builder: ToolResultBuilder,
  kind: 'stdout' | 'stderr',
  onUpdate?: ((update: ToolUpdate) => void) | undefined,
  suppressPrematureClose?: () => boolean,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      const buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
      const text = decoder.write(buf);
      if (text.length > 0) onUpdate?.({ kind, text });
      builder.write(text);
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose?.() !== true) {
      throw error;
    }
  }
  const trailing = decoder.end();
  if (trailing.length > 0) {
    onUpdate?.({ kind, text: trailing });
    builder.write(trailing);
  }
}

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}
