/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { LifecycleScope } from '#/app/scopes';

import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { userCancellationReason } from '#/_base/utils/abort';
import { escapeXml } from '#/_base/utils/xml-escape';
import { historyEntryFromContext } from '#/agent/loop/history';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ToolUpdate } from '#/tool/toolContract';
import { IAgentToolExecutorService, type AgentToolExecutionHandler } from '#/agent/toolExecutor/toolExecutor';
import { createTaskCompletionEntry } from '#/agent/task/taskOutput';
import { agentTaskInfo } from '#/agent/task/handler';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type { ToolCall } from '@moonshot-ai/core/llm/message';
import { isToolDetachAck } from '#/tool/executor';
import { AgentEvent2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IAgentShellCommandService,
  type RunShellCommandInput,
  type RunShellCommandResult,
} from './shellCommand';

export interface ShellOutputPayload {
  readonly agentId: string;
  readonly commandId: string;
  readonly update: ToolUpdate;
  readonly taskId?: string;
}

export class ShellOutput extends AgentEvent2<ShellOutputPayload> {
  static override readonly type = 'shell.output';
  static override readonly observable = true;
}
export interface ShellOutput extends ShellOutputPayload {}

export interface ShellStartedPayload {
  readonly agentId: string;
  readonly commandId: string;
  readonly taskId: string;
}

export class ShellStarted extends AgentEvent2<ShellStartedPayload> {
  static override readonly type = 'shell.started';
  static override readonly observable = true;
}
export interface ShellStarted extends ShellStartedPayload {}

export interface ShellCompletedPayload {
  readonly agentId: string;
  readonly commandId: string;
  readonly isError: boolean;
  readonly taskId?: string;
}

export class ShellCompleted extends AgentEvent2<ShellCompletedPayload> {
  static override readonly type = 'shell.completed';
  static override readonly observable = true;
}
export interface ShellCompleted extends ShellCompletedPayload {}

const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

export const shellCommandTasksKey = defineState<Map<string, string>>(
  'shellCommand.tasks',
  () => new Map(),
);

export class AgentShellCommandService extends Service implements IAgentShellCommandService {
  declare readonly _serviceBrand: undefined;
  private readonly shellCommandControllers = new Map<string, AgentToolExecutionHandler>();

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this._register(toolExecutor.registerHook({
      starting: (context) => context.context.turnId === -1 ? { skipPermitting: true } : undefined,
    }));
    this.states.contributeState(shellCommandTasksKey);
  }

  private get shellCommandTasks(): Map<string, string> {
    return this.states.get(shellCommandTasksKey);
  }

  async run(input: RunShellCommandInput): Promise<RunShellCommandResult> {
    this.appendShellInput(input.command);

    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();
    let isError = false;
    let backgrounded = false;
    const call: ToolCall = {
      type: 'function',
      id: input.commandId ?? 'shell-command',
      name: 'Bash',
      arguments: JSON.stringify({ command: input.command, timeout: SHELL_FOREGROUND_TIMEOUT_S }),
    };
    const handler = this.toolExecutor.executor.execute(call, { turnId: -1 });
    if (input.commandId !== undefined) {
      this.shellCommandControllers.set(input.commandId, handler);
      this.shellCommandTasks.set(input.commandId, handler.taskId);
      void this.dispatcher.dispatch(new ShellStarted({
        agentId: this.scopeContext.agentId,
        commandId: input.commandId,
        taskId: handler.taskId,
      }));
    }
    handler.observe((event) => {
      if (event.type !== 'output') return;
      stdout += event.text;
      if (input.commandId !== undefined) {
        void this.dispatcher.dispatch(new ShellOutput({
          agentId: this.scopeContext.agentId,
          commandId: input.commandId,
          update: { kind: 'stdout', text: event.text },
          taskId: this.shellCommandTasks.get(input.commandId),
        }));
      }
    });
    try {
      const response = await handler;
      const output = response.content.map((part) => part.type === 'text' ? part.text : '').join('');
      if (isToolDetachAck(response)) {
        this.completeDetached(call, handler);
        this.notifyBackgrounded(output);
        backgrounded = true;
        return { stdout: output, stderr: '', isError: false, backgrounded: true };
      }
      isError = response.outcome.type !== 'success';
      if (isError && stdout.length === 0 && stderr.length === 0) {
        stderr = output.length > 0 ? output : 'Command failed.';
        if (input.commandId !== undefined && stderr.length > 0) {
          void this.dispatcher.dispatch(new ShellOutput({
            agentId: this.scopeContext.agentId,
            commandId: input.commandId,
            update: { kind: 'stderr', text: stderr },
            taskId: this.shellCommandTasks.get(input.commandId),
          }));
        }
      }
      if (input.commandId !== undefined) {
        void this.dispatcher.dispatch(new ShellCompleted({
          agentId: this.scopeContext.agentId,
          commandId: input.commandId,
          isError,
          taskId: this.shellCommandTasks.get(input.commandId),
        }));
      }
      this.appendShellOutput(stdout, stderr, isError);
      return { stdout, stderr, isError };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr += message;
      isError = true;
      if (input.commandId !== undefined) {
        if (message.length > 0) {
          void this.dispatcher.dispatch(new ShellOutput({
            agentId: this.scopeContext.agentId,
            commandId: input.commandId,
            update: { kind: 'stderr', text: message },
            taskId: this.shellCommandTasks.get(input.commandId),
          }));
        }
        void this.dispatcher.dispatch(new ShellCompleted({
          agentId: this.scopeContext.agentId,
          commandId: input.commandId,
          isError: true,
          taskId: this.shellCommandTasks.get(input.commandId),
        }));
      }
      this.appendShellOutput(stdout, stderr, true);
      return { stdout, stderr, isError: true };
    } finally {
      if (!backgrounded) this.toolExecutor.release(handler.taskId);
      if (input.commandId !== undefined) {
        this.shellCommandControllers.delete(input.commandId);
        this.shellCommandTasks.delete(input.commandId);
      }
      this.telemetry.track2('shell_command_finished', {
        duration_ms: Date.now() - startedAt,
        is_error: isError,
        backgrounded,
      });
    }
  }

  private completeDetached(call: ToolCall, handler: AgentToolExecutionHandler): void {
    const started = agentTaskInfo(handler);
    void this.dispatcher.dispatch(new TaskStarted({
      agentId: this.scopeContext.agentId,
      info: { ...started, status: 'running', endedAt: null },
    }));
    const complete = (info: ReturnType<typeof agentTaskInfo>): void => {
      void this.dispatcher.dispatch(new TaskTerminated({ agentId: this.scopeContext.agentId, info }));
      const output = handler.output(info.kind === 'question' ? 16_000 : 0);
      const entry = createTaskCompletionEntry(info, call.id, {
        outputPath: output.path,
        outputSizeBytes: output.totalBytes,
        previewBytes: Buffer.byteLength(output.preview),
        truncated: output.truncated,
        fullOutputAvailable: output.path !== undefined,
        preview: output.preview,
      });
      this.loop.notify(entry);
    };
    void handler.wait().then(
      () => complete(agentTaskInfo(handler)),
      (error: unknown) => complete({
        ...agentTaskInfo(handler),
        status: 'failed',
        endedAt: Date.now(),
        stopReason: toErrorMessage(error),
      }),
    ).finally(() => {
      this.toolExecutor.release(handler.taskId);
    });
  }

  cancel(commandId: string): void {
    void this.shellCommandControllers.get(commandId)?.stop(userCancellationReason());
  }

  private appendShellInput(command: string): void {
    const text = `<bash-input>\n${escapeXml(command)}\n</bash-input>`;
    this.loop.remind(historyEntryFromContext({
      role: 'user',
      content: [{ type: 'text', text }],
      origin: { kind: 'shell_command', phase: 'input' },
    }));
  }

  private appendShellOutput(stdout: string, stderr: string, isError?: boolean): void {
    const text = `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`;
    this.loop.remind(historyEntryFromContext({
      role: 'user',
      content: [{ type: 'text', text }],
      origin:
        isError === true
          ? { kind: 'shell_command', phase: 'output', isError: true }
          : { kind: 'shell_command', phase: 'output' },
    }));
    this.loop.flushReminders();
  }

  private notifyBackgrounded(output: string): void {
    this.loop.notify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: output }],
        origin: { kind: 'injection', variant: 'shell_command_backgrounded' } as PromptOrigin,
      },
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
