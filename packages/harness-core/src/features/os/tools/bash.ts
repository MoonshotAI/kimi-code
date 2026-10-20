import { isAbsolute, join, normalize, resolve } from 'pathe';

import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { getShellPathBridge } from '#/features/os/host/execEnv/shellPathBridge';
import type { OsEnvironmentPort, OsHost, OsProcess } from '#/features/os/host/types';
import { startProcessExecution, type ProcessSettlement } from '#/features/os/process-exec';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS,
  ToolOutputAccumulator,
} from '#/features/os/output-accumulator';
import { renderPrompt } from '#/features/os/text/render-prompt';
import BASH_DESCRIPTION_TEMPLATE from './bash.md?raw';

export const BASH_TOOL_NAME = 'Bash';

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 5 * 60;
export const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
export const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;

const MS_PER_SECOND = 1000;

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
}

function foregroundDescription(args: BashArguments): string {
  const explicit = args.description?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const preview = args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command;
  return `Bash: ${preview}`;
}

function closeProcessStdin(proc: OsProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace(
    ' When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.',
    ' A foreground command that hits its timeout is killed.',
  );
}

export type BashBackgroundScenario =
  | 'background_started'
  | 'foreground_detached'
  | 'foreground_detached_by_user';

function nextStepLines(scenario: BashBackgroundScenario): string {
  if (scenario === 'foreground_detached' || scenario === 'foreground_detached_by_user') {
    const moved =
      scenario === 'foreground_detached_by_user'
        ? 'The user moved this task to the background.'
        : 'The task now runs in the background.';
    return (
      `next_step: ${moved} You will be automatically notified ` +
      `when it completes — do NOT wait, poll, or call TaskOutput on it; continue with your current work.\n`
    );
  }
  return (
    'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, ' +
    'or call TaskOutput on it; continue with your current work.\n' +
    'next_step: Use TaskStop only if the task must be cancelled.\n'
  );
}

export function renderBashBackgroundAck(options: {
  readonly taskId: string;
  readonly pid: number;
  readonly description: string;
  readonly scenario: BashBackgroundScenario;
  readonly title?: string;
  readonly foregroundOutput?: string;
}): string {
  const detachedByUser =
    options.scenario === 'foreground_detached_by_user' ? 'detached_by_user: true\n' : '';
  const metadata =
    `task_id: ${options.taskId}\n` +
    `pid: ${String(options.pid)}\n` +
    `description: ${options.description}\n` +
    `status: running\n` +
    detachedByUser +
    `automatic_notification: true\n` +
    nextStepLines(options.scenario) +
    'human_shell_hint: The task is visible in the background-task panel.';
  const foregroundOutput = options.foregroundOutput ?? '';
  const body =
    foregroundOutput.length === 0
      ? metadata
      : `${metadata}\n\nforeground_output:\n${foregroundOutput}`;
  return options.title === undefined ? body : `${options.title}\n${body}`;
}

export interface CreateBashToolProps {
  readonly host: OsHost;
  readonly workspace: {
    readonly workDir: string;
    readonly additionalDirs?: readonly string[];
  };
  readonly spillDir: string;
  readonly autoBackgroundOnTimeout?: () => boolean;
  readonly backgroundTaskTimeoutS?: () => number;
  readonly spillThresholdChars?: () => number;
}

export interface BashPendingDetach {
  running(): readonly string[];
  detach(toolCallId: string): boolean;
}

export interface BashToolDefinition extends ToolDefinition {
  readonly pending: BashPendingDetach;
}

interface BashArguments {
  command: string;
  cwd?: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  disable_timeout?: boolean;
}

function parseBashArguments(
  raw: string | null,
): { args: BashArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid Bash arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  const { command, cwd, timeout, description, run_in_background, disable_timeout } = parsed as {
    command?: unknown;
    cwd?: unknown;
    timeout?: unknown;
    description?: unknown;
    run_in_background?: unknown;
    disable_timeout?: unknown;
  };
  if (typeof command !== 'string') {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)
  ) {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  if (run_in_background !== undefined && typeof run_in_background !== 'boolean') {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  if (disable_timeout !== undefined && typeof disable_timeout !== 'boolean') {
    return { parseError: `invalid Bash arguments: ${raw}` };
  }
  return { args: { command, cwd, timeout, description, run_in_background, disable_timeout } };
}

function spawnBashProcess(
  host: OsHost,
  env: OsEnvironmentPort,
  effectiveCwd: string,
  command: string,
): Promise<OsProcess> {
  const shellCwd = getShellPathBridge(env).toShellPath(effectiveCwd);
  const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
  const noninteractiveEnv: Record<string, string> = {
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
    SHELL: env.shellPath,
  };
  return host.process.spawn(env.shellPath, ['-c', shellCommand], { env: noninteractiveEnv });
}

export function createBashTool(props: CreateBashToolProps): BashToolDefinition {
  const pendingMap = new Map<string, () => void>();

  const pending: BashPendingDetach = {
    running: () => [...pendingMap.keys()],
    detach: (toolCallId: string): boolean => {
      const fn = pendingMap.get(toolCallId);
      if (fn === undefined) return false;
      pendingMap.delete(toolCallId);
      fn();
      return true;
    },
  };

  return {
    name: BASH_TOOL_NAME,
    get description(): string {
      const rendered = renderPrompt(BASH_DESCRIPTION_TEMPLATE, {
        ...SHELL_TIMEOUT_VARS,
        SHELL_NAME: props.host.environment.shellName,
      });
      if (!(props.autoBackgroundOnTimeout?.() ?? true)) {
        return withoutAutoBackgroundOnTimeout(rendered);
      }
      return rendered;
    },
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute.',
        },
        cwd: {
          type: 'string',
          description:
            "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
        },
        timeout: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: `Optional timeout in seconds for the command to execute. Foreground default ${String(DEFAULT_TIMEOUT_S)}s, max ${String(MAX_TIMEOUT_S)}s. Background default ${String(DEFAULT_BACKGROUND_TIMEOUT_S)}s, max ${String(MAX_BACKGROUND_TIMEOUT_S)}s. Ignored for background commands when disable_timeout=true.`,
        },
        description: {
          type: 'string',
          description:
            'A short description for the background task. Required when run_in_background is true.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Whether to run the command as a background task.',
        },
        disable_timeout: {
          type: 'boolean',
          description:
            'If true, do not apply a timeout to the command. Only applies when run_in_background is true.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    pending,
    async execute({ toolCall, signal, onUpdate, detach }): Promise<ToolResult> {
      const errorText = (value: string): ToolResult => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true,
      });
      const parsed = parseBashArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return errorText(parsed.parseError);
      }
      const args = parsed.args;

      const startsInBackground = args.run_in_background === true;
      if (args.timeout !== undefined && args.timeout > timeoutCapS(startsInBackground)) {
        return errorText(
          `timeout must be ≤ ${String(timeoutCapS(startsInBackground))}s (${startsInBackground ? 'background' : 'foreground'})`,
        );
      }

      if (signal.aborted) return errorText('Aborted before command started');
      if (args.command.length === 0) return errorText('Command cannot be empty.');
      if (startsInBackground && !args.description?.trim()) {
        return errorText('description is required when run_in_background is true.');
      }

      await props.host.environment.ready;
      const env = props.host.environment;
      const command = env.osKind === 'Windows' ? rewriteWindowsNullRedirect(args.command) : args.command;
      const workDir = props.workspace.workDir;
      const rawCwd = args.cwd ?? workDir;
      const nativeCwd =
        env.pathClass === 'win32' ? getShellPathBridge(env).fromShellPath(rawCwd) : rawCwd;
      const effectiveCwd = normalize(isAbsolute(nativeCwd) ? nativeCwd : resolve(workDir, nativeCwd));

      const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
      const description = startsInBackground
        ? args.description!.trim()
        : foregroundDescription(args);
      const backgroundTimeoutMs = args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true);

      let proc: OsProcess;
      try {
        proc = await spawnBashProcess(props.host, env, effectiveCwd, command);
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
      closeProcessStdin(proc);
      if (proc.external?.kind === 'terminal') {
        onUpdate?.({ key: 'terminal', text: proc.external.id });
      }

      const toolCallId = toolCall.id;
      const builder = new ToolOutputAccumulator();
      const internal = new AbortController();

      const spillThreshold = props.spillThresholdChars?.() ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
      const spillPath = join(props.spillDir, `bash-${toolCallId}.txt`);
      let spilled = false;
      let spilledChars = 0;
      let spillChain: Promise<void> = Promise.resolve();
      const queueSpill = (chunk: string): void => {
        const remaining = DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS - spilledChars;
        if (remaining <= 0) return;
        const kept = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
        if (kept.length === 0) return;
        spilledChars += kept.length;
        spillChain = spillChain
          .then(async () => {
            await props.host.fs.appendText(spillPath, kept);
          })
          .catch(() => {});
      };
      const startSpill = (): void => {
        spilled = true;
        const snapshot = builder.snapshot();
        spilledChars = snapshot.length;
        spillChain = spillChain
          .then(async () => {
            await props.host.fs.mkdir(props.spillDir, { recursive: true });
            await props.host.fs.writeText(spillPath, snapshot);
          })
          .catch(() => {});
      };

      let detached = false;
      let timedOut = false;
      let attached = true;
      let armedTimeoutMs = foregroundTimeoutMs;

      const onAbortLink = (): void => {
        internal.abort();
      };
      if (signal.aborted) {
        internal.abort();
      } else {
        signal.addEventListener('abort', onAbortLink, { once: true });
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const clearArmedTimeout = (): void => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };
      const armTimeout = (ms: number): void => {
        clearArmedTimeout();
        armedTimeoutMs = ms;
        timeoutHandle = setTimeout(onTimeoutFired, ms);
        timeoutHandle.unref?.();
      };

      const doDetach = (scenario: BashBackgroundScenario, rearm: boolean): void => {
        if (detached || detach === undefined) return;
        detached = true;
        attached = false;
        signal.removeEventListener('abort', onAbortLink);
        if (rearm) {
          armTimeout((props.backgroundTaskTimeoutS?.() ?? DEFAULT_BACKGROUND_TIMEOUT_S) * MS_PER_SECOND);
        }
        detach(
          renderBashBackgroundAck({
            taskId: toolCallId,
            pid: proc.pid,
            description,
            scenario,
            title:
              scenario === 'foreground_detached'
                ? 'Command timed out and moved to background'
                : scenario === 'foreground_detached_by_user'
                  ? 'Task moved to background by the user'
                  : undefined,
            foregroundOutput: scenario === 'background_started' ? '' : builder.snapshot(),
          }),
        );
      };

      const onTimeoutFired = (): void => {
        if (!detached && (props.autoBackgroundOnTimeout?.() ?? true) && detach !== undefined) {
          doDetach('foreground_detached', true);
          return;
        }
        timedOut = true;
        internal.abort();
      };

      if (startsInBackground) {
        if (backgroundTimeoutMs !== undefined) armTimeout(backgroundTimeoutMs);
      } else {
        armTimeout(foregroundTimeoutMs);
      }

      const execution = startProcessExecution(proc, {
        signal: internal.signal,
        onChunk: (_kind, chunk) => {
          const wasSpilled = spilled;
          builder.write(chunk);
          if (!wasSpilled && builder.totalChars > spillThreshold) startSpill();
          else if (wasSpilled) queueSpill(chunk);
        },
        onOutput: (kind, chunk) => {
          if (attached) onUpdate?.({ key: kind, text: chunk });
        },
      });

      if (startsInBackground) {
        doDetach('background_started', false);
      } else {
        pendingMap.set(toolCallId, () => {
          doDetach('foreground_detached_by_user', true);
        });
      }

      const settlement = await execution.done;
      clearArmedTimeout();
      pendingMap.delete(toolCallId);
      signal.removeEventListener('abort', onAbortLink);
      const finished = await finishResult(settlement);
      return {
        content: [{ type: 'text' as const, text: finished.text }],
        isError: finished.isError,
      };

      async function finishResult(
        settled: ProcessSettlement,
      ): Promise<{ text: string; isError?: true }> {
        let result: string;
        let isError: true | undefined;
        let okMessage: string | undefined;
        if (settled.status === 'killed' && timedOut) {
          result = builder.error(`Command killed by timeout (${formatTimeoutLabel(armedTimeoutMs)})`);
          isError = true;
        } else if (settled.status === 'killed' && signal.aborted) {
          result = builder.error('Interrupted by user');
          isError = true;
        } else if (
          (settled.status === 'failed' || settled.status === 'killed') &&
          settled.stopReason !== undefined
        ) {
          result = builder.error(settled.stopReason);
          isError = true;
        } else if (settled.exitCode === 0) {
          okMessage = 'Command executed successfully.';
          result = builder.ok(okMessage);
        } else {
          if (builder.nChars === 0) builder.write(`Process exited with code ${String(settled.exitCode)}`);
          result = builder.error(`Command failed with exit code: ${String(settled.exitCode)}.`);
          isError = true;
        }
        if (!spilled) return { text: result, isError };
        await spillChain;
        let sizeBytes = spilledChars;
        try {
          sizeBytes = (await props.host.fs.stat(spillPath)).size;
        } catch {
        }
        const lines: string[] = [];
        if (okMessage !== undefined && builder.nChars > 0) lines.push(okMessage);
        lines.push(
          `task_id: ${toolCallId}`,
          `output_size_bytes: ${String(sizeBytes)}`,
          `next_step: The full output is saved at ${spillPath}. Use Read with path="${spillPath}" to inspect it.`,
        );
        return { text: `${result}\n${lines.join('\n')}`, isError };
      }
    },
  };
}
