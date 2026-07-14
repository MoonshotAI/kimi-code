/**
 * `shellCommand` domain (L4) — `IAgentShellCommandService` implementation.
 *
 * Runs user-initiated `!` commands through the builtin `Bash` tool from
 * `toolRegistry`, records the command and output as `shell_command`-origin
 * context messages via `contextMemory`, streams live `shell.output` /
 * `shell.started` events through `eventBus`, and steers the model through
 * `promptService` when a command is detached to background. Bound at Agent
 * scope.
 */

import type { ShellOutputEvent, ShellStartedEvent } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { escapeXml } from '#/_base/utils/xml-escape';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ToolUpdate } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';

import {
  IAgentShellCommandService,
  type RunShellCommandInput,
  type RunShellCommandResult,
} from './shellCommand';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'shell.output': ShellOutputEvent;
    'shell.started': ShellStartedEvent;
  }
}

const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

export class AgentShellCommandService implements IAgentShellCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly shellCommandControllers = new Map<string, AbortController>();

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly promptService: IAgentPromptService,
    @IEventBus private readonly eventBus: IEventBus,
  ) { }

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
            this.eventBus.publish({ type: 'shell.output', commandId: input.commandId, update });
          }
        },
        onForegroundTaskStart: (taskId: string) => {
          if (input.commandId !== undefined) {
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
      }
      this.appendShellOutput(stdout, stderr, isError);
      return { stdout, stderr, isError };
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      this.appendShellOutput(stdout, stderr, true);
      return { stdout, stderr, isError: true };
    } finally {
      if (input.commandId !== undefined) {
        this.shellCommandControllers.delete(input.commandId);
      }
    }
  }

  cancel(commandId: string): void {
    this.shellCommandControllers.get(commandId)?.abort(userCancellationReason());
  }

  private ensureBashTool() {
    const bash = this.toolRegistry.resolve('Bash');
    if (bash === undefined) {
      throw new Error('Bash tool is not registered.');
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
  InstantiationType.Delayed,
  'shellCommand',
);
