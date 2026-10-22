import { createHistoryMessageBuilder } from '@moonshot-ai/agent-core/history/index';
import type { UserMessage } from '@moonshot-ai/agent-core/llm/message';

import { createFeature, useAgent, type Feature } from '#/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  type RuntimeEvent,
} from '#/kernel/index';

import type { OsHost, OsProcess } from '#/todo-features/os/host/index';
import { startProcessExecution } from '#/todo-features/os/process-exec';
import { renderBashBackgroundAck } from '#/todo-features/os/tools/bash';
import { randomHex } from '#/random';

import { escapeXml } from './xml-escape';

export interface RunShellCommandInput {
  readonly command: string;
  readonly commandId?: string;
}

export interface RunShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError: boolean;
  readonly backgrounded?: boolean;
}

export interface ShellCommandFace {
  run(input: RunShellCommandInput): Promise<RunShellCommandResult>;
  cancel(commandId: string): void;
}

export const ShellCommandRef = createFacadeToken<ShellCommandFace>('shellCommand');

export interface ShellStartedEvent extends RuntimeEvent {
  readonly type: 'shell.started';
  readonly agentId: string;
  readonly commandId: string;
}

export interface ShellOutputEvent extends RuntimeEvent {
  readonly type: 'shell.output';
  readonly agentId: string;
  readonly commandId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ShellCompletedEvent extends RuntimeEvent {
  readonly type: 'shell.completed';
  readonly agentId: string;
  readonly commandId: string;
  readonly isError: boolean;
}

export type ShellCommandEvent = ShellStartedEvent | ShellOutputEvent | ShellCompletedEvent;

export interface CreateShellCommandProps {
  readonly workDir: string;
  readonly shell?: string;
  readonly timeoutMs?: number;
  readonly host?: OsHost;
}

export const SHELL_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

interface RunningCommand {
  readonly controller: AbortController;
  cancelled: boolean;
}

export function createShellCommand(
  props: CreateShellCommandProps,
): Feature<void, { agent: ShellCommandEvent }> {
  return createFeature<{ agent: ShellCommandEvent }>('shellCommand', {
    agent() {
      const host = props.host;
      if (host === undefined) return;
      const agent = useAgent();
      const fire = useFire();
      const workDir = props.workDir;
      const shell = props.shell ?? '/bin/bash';
      const timeoutMs = props.timeoutMs ?? SHELL_COMMAND_DEFAULT_TIMEOUT_MS;
      const agentId = agent.id;
      const running = new Map<string, RunningCommand>();
      const cancelledBeforeStart = new Set<string>();

      const _remind = (message: UserMessage, key: string): void => {
        queueMicrotask(() => {
          agent.loop.remind({ message, meta: { source: 'reminder', key } });
        });
      };

      const run = async (input: RunShellCommandInput): Promise<RunShellCommandResult> => {
        const commandId = input.commandId ?? `shell-command-${randomHex(6)}`;
        _remind(
          createHistoryMessageBuilder()
            .xml(`<bash-input>\n${escapeXml(input.command)}\n</bash-input>`, 'text/xml', {
              kind: 'shell_command',
              phase: 'input',
            })
            .userMessage(),
          `shell-command:${commandId}:input`,
        );

        const emitOutput = (stream: 'stdout' | 'stderr', text: string): void => {
          fire({ type: 'shell.output', agentId, commandId, stream, text });
        };

        let proc: OsProcess;
        try {
          proc = await host.process.spawn(shell, ['-c', input.command], { cwd: workDir });
        } catch (error) {
          const stderr = error instanceof Error ? error.message : String(error);
          emitOutput('stderr', stderr);
          fire({ type: 'shell.completed', agentId, commandId, isError: true });
          _remind(
            createHistoryMessageBuilder()
              .xml(
                `<bash-stdout></bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
                'text/xml',
                { kind: 'shell_command', phase: 'output', isError: true },
              )
              .userMessage(),
            `shell-command:${commandId}:output`,
          );
          return { stdout: '', stderr, isError: true };
        }
        try {
          proc.stdin.end();
        } catch {
        }

        const entry: RunningCommand = { controller: new AbortController(), cancelled: false };
        running.set(commandId, entry);
        if (cancelledBeforeStart.delete(commandId)) {
          entry.cancelled = true;
          entry.controller.abort();
        }
        fire({ type: 'shell.started', agentId, commandId });

        let stdout = '';
        let stderr = '';
        let combined = '';
        const execution = startProcessExecution(proc, {
          signal: entry.controller.signal,
          onChunk: (kind, text) => {
            if (kind === 'stdout') stdout += text;
            else stderr += text;
            combined += text;
            emitOutput(kind, text);
          },
        });

        return new Promise<RunShellCommandResult>((resolve) => {
          let settled = false;
          const finish = (result: RunShellCommandResult): void => {
            if (settled) return;
            settled = true;
            resolve(result);
          };

          const timer = setTimeout(() => {
            const preview =
              input.command.length > 60 ? `${input.command.slice(0, 60)}…` : input.command;
            const ack = renderBashBackgroundAck({
              taskId: commandId,
              pid: proc.pid,
              description: `Bash: ${preview}`,
              scenario: 'foreground_detached',
              title: 'Command timed out and moved to background',
              foregroundOutput: combined,
            });
            _remind(
              createHistoryMessageBuilder()
                .plain(ack, { kind: 'shell_command', phase: 'backgrounded' })
                .userMessage(),
              `shell-command:${commandId}:backgrounded`,
            );
            finish({ stdout: ack, stderr: '', isError: false, backgrounded: true });
          }, timeoutMs);
          timer.unref?.();

          void execution.done.then((settlement) => {
            clearTimeout(timer);
            running.delete(commandId);
            cancelledBeforeStart.delete(commandId);
            const exitCode = settlement.exitCode;
            const isError =
              settlement.status === 'killed' || settlement.status === 'failed' || exitCode !== 0;
            if (isError && stdout.length === 0 && stderr.length === 0) {
              stderr =
                settlement.stopReason ??
                (entry.cancelled
                  ? 'Command cancelled'
                  : exitCode === -1
                    ? 'Command terminated by signal'
                    : 'Command failed.');
              emitOutput('stderr', stderr);
            }
            fire({ type: 'shell.completed', agentId, commandId, isError });
            _remind(
              createHistoryMessageBuilder()
                .xml(
                  `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
                  'text/xml',
                  { kind: 'shell_command', phase: 'output', isError: isError ? true : undefined },
                )
                .userMessage(),
              `shell-command:${commandId}:output`,
            );
            finish({ stdout, stderr, isError });
          });
        });
      };

      const cancel = (commandId: string): void => {
        const entry = running.get(commandId);
        if (entry === undefined) {
          cancelledBeforeStart.add(commandId);
          return;
        }
        entry.cancelled = true;
        entry.controller.abort();
      };

      const _stop = (): void => {
        for (const entry of running.values()) {
          entry.controller.abort();
        }
      };

      useExpose(ShellCommandRef, { run, cancel });
      useCleanup(_stop);
    },
  });
}
