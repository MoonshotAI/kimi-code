import { randomBytes } from 'node:crypto';

import { createHistoryMessageBuilder, type AgentCommands } from '@moonshot-ai/agent-core';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import { createNodeOsHost, type OsHost, type OsProcess } from '#/features/os/host/index';
import { startProcessExecution } from '#/features/os/process-exec';
import { renderBashBackgroundAck } from '#/features/os/tools/bash';
import type { RunShellCommandInput, RunShellCommandResult, ShellCommandFace } from './feature';
import { escapeXml } from './xml-escape';

export interface ShellCommandRunnerDeps {
  readonly workDir: string;
  readonly shell: string;
  readonly timeoutMs: number;
  readonly agent: AgentCommands;
  readonly fire: (event: RuntimeEvent) => void;
  readonly host?: OsHost;
}

export interface ShellCommandRunner {
  readonly face: ShellCommandFace;
  stop(): void;
}

interface RunningCommand {
  readonly controller: AbortController;
  cancelled: boolean;
}

export function openShellCommands(deps: ShellCommandRunnerDeps): ShellCommandRunner {
  const { workDir, shell, timeoutMs, agent, fire } = deps;
  const host = deps.host ?? createNodeOsHost();
  const agentId = agent.agentId;
  const running = new Map<string, RunningCommand>();
  const cancelledBeforeStart = new Set<string>();

  const run = async (input: RunShellCommandInput): Promise<RunShellCommandResult> => {
    const commandId = input.commandId ?? `shell-command-${randomBytes(6).toString('hex')}`;
    agent.remind(
      createHistoryMessageBuilder()
        .xml(`<bash-input>\n${escapeXml(input.command)}\n</bash-input>`, 'text/xml', {
          kind: 'shell_command',
          phase: 'input',
        })
        .userMessage(),
      { key: `shell-command:${commandId}:input` },
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
      agent.remind(
        createHistoryMessageBuilder()
          .xml(
            `<bash-stdout></bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
            'text/xml',
            { kind: 'shell_command', phase: 'output', isError: true },
          )
          .userMessage(),
        { key: `shell-command:${commandId}:output` },
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
        agent.remind(
          createHistoryMessageBuilder()
            .plain(ack, { kind: 'shell_command', phase: 'backgrounded' })
            .userMessage(),
          { key: `shell-command:${commandId}:backgrounded` },
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
        agent.remind(
          createHistoryMessageBuilder()
            .xml(
              `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
              'text/xml',
              { kind: 'shell_command', phase: 'output', isError: isError ? true : undefined },
            )
            .userMessage(),
          { key: `shell-command:${commandId}:output` },
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

  const stop = (): void => {
    for (const entry of running.values()) {
      entry.controller.abort();
    }
  };

  return { face: { run, cancel }, stop };
}
