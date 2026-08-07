/**
 * `shellCommand` domain — `IAgentShellCommandService` implementation.
 *
 * Runs user-initiated `!` commands through the builtin `Bash` tool from
 * `toolRegistry`, records the command and output as `shell_command`-origin
 * context messages via `contextMemory`, streams live `shell.output` /
 * `shell.started` / `shell.completed` events through `eventBus`, and steers
 * the model through `promptService` when a command is detached to background.
 * Bound at Agent scope.
 *
 * `shell.completed` fires once when a foreground command settles (success or
 * failure); runs detached to background do NOT fire it — they report through
 * the task lifecycle instead. `shell.output` / `shell.completed` carry the
 * foreground process `taskId` once that task is registered, so consumers that
 * missed `shell.started` can still route the chunk. A failure text that was
 * never streamed (empty stdout/stderr) is emitted as a `shell.output` chunk
 * before `shell.completed`, so live consumers see the output too.
 *
 * The plain-data state (`shellCommandTasks`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; `shellCommandControllers`
 * stays an instance field (per-command `AbortController`s, not plain data).
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { userCancellationReason } from '#/_base/utils/abort';
import { escapeXml } from '#/_base/utils/xml-escape';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ToolUpdate } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';

import {
  IAgentShellCommandService,
  type RunShellCommandInput,
  type RunShellCommandResult,
} from './shellCommand';

export interface ShellOutputEvent {
  readonly type: 'shell.output';
  readonly commandId: string;
  readonly update: ToolUpdate;
  readonly taskId?: string;
}

export interface ShellStartedEvent {
  readonly type: 'shell.started';
  readonly commandId: string;
  readonly taskId: string;
}

export interface ShellCompletedEvent {
  readonly type: 'shell.completed';
  readonly commandId: string;
  readonly isError: boolean;
  readonly taskId?: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'shell.output': ShellOutputEvent;
    'shell.started': ShellStartedEvent;
    'shell.completed': ShellCompletedEvent;
  }
}

const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

export const shellCommandTasksKey = defineState<Map<string, string>>(
  'shellCommand.tasks',
  () => new Map(),
);

export class AgentShellCommandService implements IAgentShellCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly shellCommandControllers = new Map<string, AbortController>();

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    this.states.register(shellCommandTasksKey);
  }

  private get shellCommandTasks(): Map<string, string> {
    return this.states.get(shellCommandTasksKey);
  }

  async run(input: RunShellCommandInput): Promise<RunShellCommandResult> {
    this.appendShellInput(input.command);

    const controller = new AbortController();
    if (input.commandId !== undefined) {
      this.shellCommandControllers.set(input.commandId, controller);
    }

    let stdout = '';
    let stderr = '';
    try {
      const bash = this.ensureBashTool();
      const execution = await bash.resolveExecution({
        command: input.command,
        timeout: SHELL_FOREGROUND_TIMEOUT_S,
      });
      if (execution.isError === true) {
        const output = typeof execution.output === 'string' ? execution.output : 'Command failed.';
        this.appendShellOutput('', output);
        return { stdout: '', stderr: output, isError: true };
      }

      const result = await execution.execute({
        turnId: -1,
        toolCallId: 'shell-command',
        signal: controller.signal,
        onUpdate: (update: ToolUpdate) => {
          if (update.kind === 'stdout') stdout += update.text ?? '';
          else if (update.kind === 'stderr') stderr += update.text ?? '';
          else return;
          if (input.commandId !== undefined) {
            this.eventBus.publish({
              type: 'shell.output',
              commandId: input.commandId,
              update,
              taskId: this.shellCommandTasks.get(input.commandId),
            });
          }
        },
        onForegroundTaskStart: (taskId: string) => {
          if (input.commandId !== undefined) {
            this.shellCommandTasks.set(input.commandId, taskId);
            this.eventBus.publish({ type: 'shell.started', commandId: input.commandId, taskId });
          }
        },
      });

      const isError = result.isError === true;
      if (typeof result.output === 'string' && result.output.startsWith('task_id: ')) {
        this.notifyBackgrounded(result.output);
        return { stdout: result.output, stderr: '', isError: false, backgrounded: true };
      }
      if (isError && stdout.length === 0 && stderr.length === 0) {
        stderr = typeof result.output === 'string' ? result.output : 'Command failed.';
        if (input.commandId !== undefined && stderr.length > 0) {
          this.eventBus.publish({
            type: 'shell.output',
            commandId: input.commandId,
            update: { kind: 'stderr', text: stderr },
            taskId: this.shellCommandTasks.get(input.commandId),
          });
        }
      }
      if (input.commandId !== undefined) {
        this.eventBus.publish({
          type: 'shell.completed',
          commandId: input.commandId,
          isError,
          taskId: this.shellCommandTasks.get(input.commandId),
        });
      }
      this.appendShellOutput(stdout, stderr, isError);
      return { stdout, stderr, isError };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr += message;
      if (input.commandId !== undefined) {
        if (message.length > 0) {
          this.eventBus.publish({
            type: 'shell.output',
            commandId: input.commandId,
            update: { kind: 'stderr', text: message },
            taskId: this.shellCommandTasks.get(input.commandId),
          });
        }
        this.eventBus.publish({
          type: 'shell.completed',
          commandId: input.commandId,
          isError: true,
          taskId: this.shellCommandTasks.get(input.commandId),
        });
      }
      this.appendShellOutput(stdout, stderr, true);
      return { stdout, stderr, isError: true };
    } finally {
      if (input.commandId !== undefined) {
        this.shellCommandControllers.delete(input.commandId);
        this.shellCommandTasks.delete(input.commandId);
      }
    }
  }

  cancel(commandId: string): void {
    this.shellCommandControllers.get(commandId)?.abort(userCancellationReason());
  }

  private ensureBashTool() {
    const bash = this.toolRegistry.resolve('Bash');
    if (bash === undefined) {
      throw new Error2(ErrorCodes.INTERNAL, 'Bash tool is not registered.');
    }
    return bash;
  }

  private appendShellInput(command: string): void {
    const text = `<bash-input>\n${escapeXml(command)}\n</bash-input>`;
    this.context.append({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'shell_command', phase: 'input' },
    });
  }

  private appendShellOutput(stdout: string, stderr: string, isError?: boolean): void {
    const text = `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`;
    this.context.append({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin:
        isError === true
          ? { kind: 'shell_command', phase: 'output', isError: true }
          : { kind: 'shell_command', phase: 'output' },
    });
  }

  private notifyBackgrounded(output: string): void {
    void this.promptService.inject({
      role: 'user',
      content: [{ type: 'text', text: output }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'shell_command_backgrounded' },
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentShellCommandService,
  AgentShellCommandService,
  ScopeActivation.OnScopeCreated,
  'shellCommand',
);
