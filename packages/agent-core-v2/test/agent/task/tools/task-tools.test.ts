import { PassThrough, Readable, type Writable } from 'node:stream';

import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTaskInfo,
  type AgentTaskOutputChunk,
  type AgentTaskOutputSnapshot,
} from '#/agent/task/task';
import {
  type AgentTaskStatus,
  type ProcessTaskInfo,
  type SubagentTaskInfo,
  TERMINAL_STATUSES,
} from '#/agent/task/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TaskListInputSchema } from '#/agent/tools/task/task-list/task-list';
import { TaskListTool } from '#/agent/tools/task/task-list/taskListTool';
import { TaskOutputInputSchema } from '#/agent/tools/task/task-output/task-output';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { TaskStopInputSchema } from '#/agent/tools/task/task-stop/task-stop';
import { TaskStopTool } from '#/agent/tools/task/task-stop/taskStopTool';
import { WaitForInputSchema } from '#/agent/tools/task/task-wait/task-wait';
import { WaitForTool, startWaitProgress, waitForProgressUpdate } from '#/agent/tools/task/task-wait/taskWaitTool';
import { abortError } from '#/_base/utils/abort';
import { Event } from '#/_base/event';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import { LegacyExecutableToolAdapter, ToolExecutor as HandlerToolExecutor } from '#/tool/executor';
import {
  createTaskChannel,
  installControlledTask,
  startControlledTask,
  startControlledTaskInLoop,
} from '../stubs';
import type { AgentTaskFields } from '#/agent/task/handler';
import type { AgentToolExecutionHandler } from '#/agent/toolExecutor/toolExecutor';
import type { ToolExecutionSnapshot, ToolResult, ToolDetachAck } from '#/tool/executor';
import { IWaitForTool } from '#/agent/tools/task/task-wait/task-wait';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { ToolUpdated } from '#/agent/toolExecutor/toolExecutorEvents';
import { IEventBus } from '#/app/event/eventBus';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../../../app/telemetry/stubs';
import { stubFlag } from '../../../app/flag/stubs';
import { stubGoal } from '../../../features/goal/stubs';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createTestAgent, telemetryServices } from '../../../harness';

const signal = new AbortController().signal;

function context<Input>(
  toolCallId: string,
  args: Input,
  executionSignal: AbortSignal = signal,
) {
  return { turnId: 0, toolCallId, args, signal: executionSignal };
}

function agentScope(agentId = 'main') {
  return makeAgentScopeContext({ agentId, agentScope: agentId });
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function taskNotifications(ctx: ReturnType<typeof createTestAgent>, taskId: string) {
  return ctx.context.history().filter((message) =>
    message.origin?.kind === 'task' && message.origin.taskId === taskId,
  );
}

function processTask(
  overrides: Partial<ProcessTaskInfo> = {},
): ProcessTaskInfo {
  return {
    taskId: 'bash-abc12345',
    kind: 'process',
    command: 'sleep 60',
    description: 'test task',
    pid: 12345,
    exitCode: null,
    status: 'running',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    ...overrides,
  };
}

function agentTaskInfo(
  overrides: Partial<SubagentTaskInfo> = {},
): SubagentTaskInfo {
  return {
    taskId: 'agent-abc12345',
    kind: 'agent',
    description: 'agent task',
    agentId: 'agent-child',
    subagentType: 'coder',
    status: 'completed',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function outputSnapshot(
  preview = '',
  overrides: Partial<AgentTaskOutputSnapshot> = {},
): AgentTaskOutputSnapshot {
  const size = Buffer.byteLength(preview);
  return {
    outputSizeBytes: size,
    previewBytes: size,
    truncated: false,
    fullOutputAvailable: false,
    preview,
    ...overrides,
  };
}

interface FakeTaskEntry {
  info: AgentTaskInfo;
  output: AgentTaskOutputSnapshot;
  handler: AgentToolExecutionHandler;
}

function fakeTaskFields(info: AgentTaskInfo): AgentTaskFields {
  const base = {
    description: info.description,
    timeoutMs: info.timeoutMs,
    timedOut: info.status === 'timed_out' || undefined,
    stopReason: info.stopReason,
  };
  switch (info.kind) {
    case 'process':
      return {
        ...base,
        kind: 'process',
        command: info.command,
        pid: info.pid,
        exitCode: info.exitCode,
        parentToolCallId: info.parentToolCallId,
      };
    case 'agent':
      return {
        ...base,
        kind: 'agent',
        agentId: info.agentId,
        subagentType: info.subagentType,
        parentToolCallId: info.parentToolCallId,
        model: info.model,
        thinkingEffort: info.thinkingEffort,
        stopCode: info.stopCode,
        swarmIndex: info.swarmIndex,
        stateReason: info.stateReason,
        resultSummary: info.resultSummary,
      };
    case 'question':
      return {
        ...base,
        kind: 'question',
        questionCount: info.questionCount,
        toolCallId: info.toolCallId,
      };
  }
}

function fakeToolResult(info: AgentTaskInfo): ToolResult {
  const failed = info.status === 'failed' || info.status === 'timed_out';
  return {
    toolCallId: info.kind === 'question' ? info.toolCallId ?? info.taskId : info.parentToolCallId ?? info.taskId,
    content: [{ type: 'text', text: info.stopReason ?? '' }],
    outcome: failed
      ? {
          type: 'failed',
          error: {
            outcome: 'failed',
            type: 'unknown',
            phase: 'execute',
            reason: info.stopReason ?? info.status,
          },
        }
      : info.status === 'killed'
        ? {
            type: 'aborted',
            error: {
              outcome: 'aborted',
              type: 'stopped',
              phase: 'execute',
              reason: info.stopReason ?? info.status,
            },
          }
        : { type: 'success' },
  };
}

class FakeTaskService implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;
  readonly onDidAppendOutput = Event.None as Event<AgentTaskOutputChunk>;
  readonly onDidChangeTask = Event.None as Event<AgentTaskInfo>;

  readonly stopCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];
  waitDelegate:
    | ((
        taskId: string,
        timeoutMs: number | undefined,
        signal: AbortSignal | undefined,
      ) => Promise<AgentTaskInfo | undefined>)
    | undefined;

  private readonly entries = new Map<string, FakeTaskEntry>();

  add(
    info: AgentTaskInfo,
    output: AgentTaskOutputSnapshot = outputSnapshot(),
  ): string {
    const entry = {} as FakeTaskEntry;
    entry.info = info;
    entry.output = output;
    entry.handler = this.createHandler(entry);
    this.entries.set(info.taskId, entry);
    return info.taskId;
  }

  private createHandler(entry: FakeTaskEntry): AgentToolExecutionHandler {
    const snapshot = (): ReturnType<AgentToolExecutionHandler['snapshot']> => {
      const info = entry.info;
      const status = info.status === 'running'
        ? 'running'
        : info.status === 'completed'
          ? 'success'
          : info.status === 'killed'
            ? 'aborted'
            : 'failed';
      const endedAt = info.endedAt;
      return {
        id: info.kind === 'question' ? info.toolCallId ?? info.taskId : info.parentToolCallId ?? info.taskId,
        taskId: info.taskId,
        name: info.kind,
        status,
        phase: 'execute',
        args: {},
        timing: {
          total: {
            startedAt: info.startedAt,
            endedAt,
            elapsedMs: Math.max(0, (endedAt ?? Date.now()) - info.startedAt),
          },
          execute: null,
        },
        detached: info.detached ?? false,
        fields: { task: fakeTaskFields(info) },
        stopReason: info.stopReason,
      };
    };
    const handler: Omit<AgentToolExecutionHandler, 'then'> = {
      taskId: entry.info.taskId,
      snapshot,
      fields: () => ({ task: fakeTaskFields(entry.info) }),
      output: () => ({
        totalBytes: entry.output.outputSizeBytes,
        preview: entry.output.preview,
        truncated: entry.output.truncated,
        path: entry.output.outputPath,
      }),
      wait: async (timeoutMs, waitSignal) => {
        await this.wait(entry.info.taskId, timeoutMs, waitSignal);
        return fakeToolResult(entry.info);
      },
      stop: async (reason) => {
        await this.stop(entry.info.taskId, typeof reason === 'string' ? reason : undefined);
        return fakeToolResult(entry.info);
      },
      detach: (_reason, acknowledgement) => {
        this.detach(entry.info.taskId);
        const ack: ToolDetachAck = {
          detached: true,
          taskId: entry.info.taskId,
          toolCallId: snapshot().id,
          content: acknowledgement?.content ?? [],
        };
        return ack;
      },
      observe: () => () => {},
    };
    return Object.assign(Promise.resolve().then(() => fakeToolResult(entry.info)), handler);
  }

  handlers(): readonly AgentToolExecutionHandler[] {
    return Array.from(this.entries.values(), (entry) => entry.handler);
  }

  handler(taskId: string): AgentToolExecutionHandler | undefined {
    return this.entries.get(taskId)?.handler;
  }

  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined {
    return this.handlers().find((handler) => handler.snapshot().id === toolCallId);
  }

  release(): void {}

  settle(taskId: string, status: AgentTaskStatus = 'completed'): void {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      status,
      endedAt: entry.info.endedAt ?? 1_700_000_002_000,
    } as AgentTaskInfo;
  }

  refresh(): void {}

  getTask(taskId: string): AgentTaskInfo | undefined {
    return this.entries.get(taskId)?.info;
  }

  list(activeOnly = true, limit?: number): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    for (const entry of this.entries.values()) {
      const info = entry.info;
      if (activeOnly && TERMINAL_STATUSES.has(info.status)) continue;
      if (!activeOnly && TERMINAL_STATUSES.has(info.status) && info.detached === false) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  persistOutput(_taskId: string): void {}

  readonly failSnapshotTaskIds = new Set<string>();

  async getOutputSnapshot(
    taskId: string,
    _maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    if (this.failSnapshotTaskIds.has(taskId)) throw new Error('snapshot read failed');
    return this.entries.get(taskId)?.output ?? outputSnapshot();
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const preview = this.entries.get(taskId)?.output.preview ?? '';
    if (tail === undefined) return preview;
    return preview.slice(-Math.max(0, Math.trunc(tail)));
  }

  async readOutputTail(): Promise<never> {
    throw new Error('FakeTaskService.readOutputTail is not implemented');
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    entry.info = {
      ...entry.info,
      detached: true,
    } as AgentTaskInfo;
    return entry.info;
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    this.stopCalls.push({ taskId, reason });
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.info.status)) return entry.info;
    entry.info = {
      ...entry.info,
      status: 'killed',
      endedAt: 1_700_000_002_000,
      stopReason: reason,
      ...(entry.info.kind === 'process' ? { exitCode: 143 } : undefined),
    } as AgentTaskInfo;
    return entry.info;
  }

  async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.stop(taskId, 'Aborted by the user');
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const stopped = await Promise.all(
      Array.from(this.entries.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return stopped.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    return this.stopAll(reason);
  }

  async wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    this.waitCalls.push({ taskId, timeoutMs });
    if (this.waitDelegate !== undefined) {
      return this.waitDelegate(taskId, timeoutMs, signal);
    }
    return this.entries.get(taskId)?.info;
  }

}

function taskListTool(tasks: FakeTaskService): TaskListTool {
  return new TaskListTool(
    tasks as unknown as ConstructorParameters<typeof TaskListTool>[0],
    tasks as unknown as ConstructorParameters<typeof TaskListTool>[1],
  );
}

function taskOutputTool(tasks: FakeTaskService): TaskOutputTool {
  return new TaskOutputTool(
    tasks as unknown as ConstructorParameters<typeof TaskOutputTool>[0],
    tasks as unknown as ConstructorParameters<typeof TaskOutputTool>[1],
    tasks as unknown as ConstructorParameters<typeof TaskOutputTool>[2],
  );
}

function taskStopTool(tasks: FakeTaskService): TaskStopTool {
  return new TaskStopTool(
    tasks as unknown as ConstructorParameters<typeof TaskStopTool>[0],
    tasks as unknown as ConstructorParameters<typeof TaskStopTool>[1],
  );
}

describe('TaskListTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = taskListTool(new FakeTaskService());

    expect(tool.name).toBe('TaskList');
    expect(TaskListInputSchema.safeParse({}).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 1 }).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 0 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    });
  });

  it('returns the empty active-task message', async () => {
    const result = await executeTool(
      taskListTool(new FakeTaskService()),
      context('task_list_empty', { active_only: true }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain(
      'active_background_tasks: 0\nNo background tasks found.',
    );
  });

  it('lists active process tasks', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-running1',
        command: 'sleep 60',
        description: 'running list',
      }),
    );

    const result = await executeTool(
      taskListTool(tasks),
      context('task_list_active', { active_only: true }),
    );
    const output = outputString(result);

    expect(output).toMatch(/^active_background_tasks:\s*1/);
    expect(output).toContain('kind: process');
    expect(output).toContain('task_id: bash-running1');
    expect(output).toContain('command: sleep 60');
    expect(output).toContain('description: running list');
    expect(output).toMatch(/Wall time: \d+\.\d{3} seconds/);
    expect(output).not.toMatch(/^started_at:/m);
  });

  it(
    'excludes terminal tasks from active_only=true and includes them when all tasks are listed',
    async () => {
      const tasks = new FakeTaskService();
      const taskId = tasks.add(
        processTask({
          taskId: 'bash-failed01',
          command: 'exit 7',
          description: 'exit code test',
          status: 'failed',
          endedAt: 1_700_000_001_000,
          exitCode: 7,
        }),
      );

      const active = await executeTool(
        taskListTool(tasks),
        context('task_list_active_terminal', { active_only: true }),
      );
      expect(outputString(active)).toContain(
        'active_background_tasks: 0\nNo background tasks found.',
      );

      const all = await executeTool(
        taskListTool(tasks),
        context('task_list_all_terminal', { active_only: false }),
      );
      const output = outputString(all);

      expect(output).toMatch(/^background_tasks:\s*1/);
      expect(output).toContain(taskId);
      expect(output).toContain('status: failed');
      expect(output).toContain('exit_code: 7');
    },
  );

  it('honours the limit parameter', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-first001', description: 'one' }));
    tasks.add(processTask({ taskId: 'bash-second01', description: 'two' }));

    const result = await executeTool(
      taskListTool(tasks),
      context('task_list_limit', { active_only: true, limit: 1 }),
    );
    const output = outputString(result);

    expect(output).toContain('active_background_tasks: 1');
    expect(output).toContain('bash-first001');
    expect(output).not.toContain('bash-second01');
  });

  it('includes stop_reason for stopped tasks in all-tasks view', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-stopped1',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'superseded by newer task',
      }),
    );

    const result = await executeTool(
      taskListTool(tasks),
      context('task_list_stop_reason', { active_only: false }),
    );

    expect(outputString(result)).toContain('stop_reason: superseded by newer task');
  });

  it('does not wait when listing a running task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running2', description: 'running task' }));
    const wait = vi.spyOn(tasks, 'wait');

    const result = await executeTool(
      taskListTool(tasks),
      context('task_list_no_wait', { active_only: true }),
    );

    expect(outputString(result)).toContain('running task');
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('TaskOutputTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = taskOutputTool(new FakeTaskService());

    expect(tool.name).toBe('TaskOutput');
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
      },
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"block"');
    expect(JSON.stringify(tool.parameters)).not.toContain('"timeout"');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      taskOutputTool(new FakeTaskService()),
      context('task_output_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  });

  it('returns live output when no persisted log is available', async () => {
    const tasks = new FakeTaskService();
    const payload = 'DETACHED-PAYLOAD-LINE\n';
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-live0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot(payload),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_live', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(result).toMatchObject({ isError: false });
    expect(output).toContain('retrieval_status: success');
    expect(output).toContain('status: completed');
    expect(output).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(output).toContain(`output_size_bytes: ${Buffer.byteLength(payload).toString()}`);
    expect(output).not.toContain('output_path:');
  });

  it('returns persisted output path and guidance when a log is available', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-persist1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('STDOUT-PAYLOAD-LINE\n', {
        outputPath: '/tmp/session/tasks/bash-persist1/output.log',
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_persisted', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: completed');
    expect(output).toContain('output_path: /tmp/session/tasks/bash-persist1/output.log');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).toContain('full_output_hint:');
    expect(output).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
  });

  it('returns agent metadata and final summary without process fields', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo(), outputSnapshot('SUBAGENT-FINAL-SUMMARY\n'));

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_agent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('kind: agent');
    expect(output).toContain('agent_id: agent-child');
    expect(output).toContain('subagent_type: coder');
    expect(output).toContain('Wall time: 1.000 seconds');
    expect(output.indexOf('Wall time:')).toBeLessThan(output.indexOf('status: completed'));
    expect(output).not.toMatch(/^started_at:/m);
    expect(output).not.toMatch(/^ended_at:/m);
    expect(output).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(output).not.toMatch(/^pid:/m);
    expect(output).not.toMatch(/^command:/m);
    expect(output).not.toMatch(/^exit_code:/m);
  });

  it('returns not_ready for non-blocking running tasks', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-running3' }));

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_not_ready', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('retrieval_status: not_ready');
    expect(output).toContain('status: running');
    expect(output).not.toContain('next_step');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('rejects stale block/timeout args at the validator instead of waiting', () => {
    const validator = compileToolArgsValidator(taskOutputTool(new FakeTaskService()).parameters);

    expect(validateToolArgs(validator, { task_id: 'bash-1' })).toBeNull();
    const stale = validateToolArgs(validator, { task_id: 'bash-1', block: true, timeout: 1 });
    expect(stale).toContain("must NOT have additional property 'block'");
    expect(stale).toContain("must NOT have additional property 'timeout'");
  });

  it('surfaces timeout terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-timeout1',
        status: 'timed_out',
        endedAt: 1_700_000_001_000,
      }),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_timed_out', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: timed_out');
    expect(output).not.toContain('stop_reason:');
    expect(output).toContain('terminal_reason: timed_out');
  });

  it('surfaces stopped terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-stopped2',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'operator cancelled',
      }),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_stopped', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: killed');
    expect(output).toContain('stop_reason: operator cancelled');
    expect(output).toContain('terminal_reason: stopped');
  });

  it('does not advertise output_path when the persisted log file does not exist', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-silent01',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_silent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).not.toContain('output_path:');
    expect(output).toContain('output_size_bytes: 0');
    expect(output).toContain('full_output_available: false');
    expect(output).toContain('[output]\n[no output available]');
  });

  it('renders a truncation banner and tail preview when the snapshot is truncated', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-trunc001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('TAIL-MARKER\n', {
        outputPath: '/tmp/session/tasks/bash-trunc001/output.log',
        outputSizeBytes: 200 * 1024,
        previewBytes: 32 * 1024,
        truncated: true,
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      taskOutputTool(tasks),
      context('task_output_truncated', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('output_truncated: true');
    expect(output).toContain('output_size_bytes: 204800');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).toContain(
      '[Truncated. Full output: /tmp/session/tasks/bash-trunc001/output.log]',
    );
    expect(output).toContain('TAIL-MARKER');
  });
});

describe('TaskStopTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = taskStopTool(new FakeTaskService());

    expect(tool.name).toBe('TaskStop');
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1', reason: '' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
    });
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      taskStopTool(new FakeTaskService()),
      context('task_stop_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  });

  it('stops a running task and records the reason without suppressing terminal notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-stop0001' }));

    const result = await executeTool(
      taskStopTool(tasks),
      context('task_stop_running', { task_id: taskId, reason: 'custom stop reason' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output.split('\n')[0]).toBe('Wall time: 2.000 seconds');
    expect(output).toContain('task_id: bash-stop0001');
    expect(output).toContain('status: killed');
    expect(output).toContain('reason: custom stop reason');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'custom stop reason' }]);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'killed',
      stopReason: 'custom stop reason',
    });
    expect(tasks.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  });

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-default1' }));

    const result = await executeTool(
      taskStopTool(tasks),
      context('task_stop_default_reason', { task_id: taskId, reason }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('reason: Stopped by TaskStop');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'Stopped by TaskStop' }]);
    expect(tasks.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  });

  it('returns info when task is already terminal without suppressing notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      taskStopTool(tasks),
      context('task_stop_terminal', { task_id: taskId }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')).toEqual([
      'Wall time: 1.000 seconds',
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(tasks.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  });

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-blank001',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: '',
      }),
    );

    const result = await executeTool(
      taskStopTool(tasks),
      context('task_stop_blank_stored_reason', { task_id: 'bash-blank001' }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')[3]).toBe(
      'reason: Task already in terminal state',
    );
  });
});

function waitForTool(
  tasks: FakeTaskService,
  telemetry: ConstructorParameters<typeof WaitForTool>[2],
  flags: ConstructorParameters<typeof WaitForTool>[3],
  goals: ConstructorParameters<typeof WaitForTool>[4],
  scope: ConstructorParameters<typeof WaitForTool>[5],
): WaitForTool {
  return new WaitForTool(
    tasks as unknown as ConstructorParameters<typeof WaitForTool>[0],
    tasks as unknown as ConstructorParameters<typeof WaitForTool>[1],
    telemetry,
    flags,
    goals,
    scope,
  );
}

describe('WaitForTool', () => {
  function waitTelemetry(): { records: TelemetryRecord[]; telemetry: ReturnType<typeof recordingTelemetry> } {
    const records: TelemetryRecord[] = [];
    return { records, telemetry: recordingTelemetry(records) };
  }

  function lastEvent(records: TelemetryRecord[]): TelemetryRecord | undefined {
    return records.findLast((record) => record.event === 'wait_for_completed');
  }

  it('has name and accepts the current schema', () => {
    const tool = waitForTool(new FakeTaskService(), recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope());

    expect(tool.name).toBe('WaitFor');
    expect(WaitForInputSchema.safeParse({ timeout: 60 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 60, task_id: 'bash-1' }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 90 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({}).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: -5 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 91 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 1.5 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['timeout'],
      properties: {
        timeout: { type: 'integer' },
        task_id: { type: 'string' },
      },
    });
  });

  it('returns error and tracks task_not_found for an unknown task_id', async () => {
    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      waitForTool(new FakeTaskService(), telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_unknown', { timeout: 10, task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'task_not_found',
      timeout_ms: 10_000,
      has_task_id: true,
      extra_completed_count: 0,
    });
  });

  it('returns immediately without waiting when no background tasks are running', async () => {
    const tasks = new FakeTaskService();
    const result = await executeTool(
      waitForTool(tasks, recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope()),
      context('wait_none', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: no_tasks');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
  });

  it('returns a finished task immediately without reading output or marking it delivered', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0002',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('DONE-OUTPUT\n'),
    );

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      waitForTool(tasks, telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_done', { timeout: 10, task_id: taskId }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('status: completed');
    expect(output).toContain('[finished]');
    expect(output).not.toContain('[output]\nDONE-OUTPUT');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: true,
      extra_completed_count: 0,
    });
  });

  it('reports no progress for a wait that returns at once', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({ taskId: 'bash-done0003', status: 'completed', endedAt: 1_700_000_001_000, exitCode: 0 }),
      outputSnapshot('DONE\n'),
    );
    const onUpdate = vi.fn();

    await executeTool(waitForTool(tasks, recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope()), {
      ...context('wait_done_at_once', { timeout: 10, task_id: taskId }),
      onUpdate,
    });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('reports tasks that finished during the wait without marking them delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wait001', description: 'main wait' }), outputSnapshot('WAITED-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-extra001', description: 'side task' }));
    tasks.waitDelegate = async (taskId) => {
      tasks.settle('bash-wait001');
      tasks.settle('bash-extra001', 'failed');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      waitForTool(tasks, telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_extras', { timeout: 10, task_id: 'bash-wait001' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('[completed_during_wait]');
    expect(output).toContain('task_id: bash-extra001');
    expect(output).toContain('status: failed');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      extra_completed_count: 1,
    });
  });

  it('waits for any running task when task_id is omitted', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-a1', description: 'task A' }), outputSnapshot('A-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-b1', description: 'task B' }));
    tasks.waitDelegate = async (taskId) => {
      if (taskId === 'bash-a1') tasks.settle('bash-a1');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      waitForTool(tasks, telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_any', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('task_id: bash-a1');
    expect(output).not.toContain('[output]\nA-OUT');
    expect(output).toContain('[still_running]');
    expect(output).toContain('task_id: bash-b1');
    expect(tasks.waitCalls).toHaveLength(2);
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: false,
      extra_completed_count: 0,
    });
  });

  it('returns the still-running list on timeout without marking anything delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running9', description: 'slow task' }));

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      waitForTool(tasks, telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_timeout', { timeout: 10, task_id: 'bash-running9' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: timed_out');
    expect(output).toContain('[still_running]');
    expect(output).toContain('bash-running9');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'timed_out',
      timeout_ms: 10_000,
      has_task_id: true,
    });
  });

  it('propagates an abort of the execution signal and tracks the aborted outcome', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort01' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const { records, telemetry } = waitTelemetry();
    const controller = new AbortController();
    const pending = executeTool(
      waitForTool(tasks, telemetry, stubFlag(true), stubGoal(), agentScope()),
      context('wait_abort', { timeout: 90, task_id: 'bash-abort01' }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
    expect(lastEvent(records)?.properties).toMatchObject({ outcome: 'aborted' });
  });

  it('propagates an abort from a general wait and leaves tasks running', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort02' }));
    tasks.add(processTask({ taskId: 'bash-abort03' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const controller = new AbortController();
    const pending = executeTool(
      waitForTool(tasks, recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope()),
      context('wait_abort_any', { timeout: 90 }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.getTask('bash-abort02')?.status).toBe('running');
    expect(tasks.getTask('bash-abort03')?.status).toBe('running');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
  });

  it('does not read task output or mark the task delivered when a wait finishes', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-fmtfail1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );
    tasks.failSnapshotTaskIds.add(taskId);

    const result = await executeTool(
      waitForTool(tasks, recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope()),
      context('wait_fmt_fail', { timeout: 10, task_id: taskId }),
    );
    expect(outputString(result)).toContain('wait_status: completed');
    expect(outputString(result)).not.toContain('[output]');
    expect(tasks.list(false).every((info) => info.terminalNotificationSuppressed !== true)).toBe(true);
  });

  it('aborts the losing waits once the race resolves', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-win0001' }));
    tasks.add(processTask({ taskId: 'bash-lose001' }));
    const signals = new Map<string, AbortSignal>();
    tasks.waitDelegate = (taskId, _timeoutMs, waitSignal) => {
      signals.set(taskId, waitSignal!);
      if (taskId === 'bash-win0001') {
        tasks.settle('bash-win0001');
        return Promise.resolve(tasks.getTask(taskId));
      }
      return new Promise<AgentTaskInfo | undefined>(() => {});
    };

    const result = await executeTool(
      waitForTool(tasks, recordingTelemetry([]), stubFlag(true), stubGoal(), agentScope()),
      context('wait_losers', { timeout: 90 }),
    );

    expect(outputString(result)).toContain('wait_status: completed');
    expect(signals.get('bash-lose001')?.aborted).toBe(true);
  });

  it('rejects execution when the wait_for flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-flagoff1' }));

    const result = await executeTool(
      waitForTool(tasks, recordingTelemetry([]), stubFlag(false), stubGoal(), agentScope()),
      context('wait_flag_off', { timeout: 10, task_id: 'bash-flagoff1' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('wait_for experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('emits status and structured fields while the wait is pending', async () => {
    const update = waitForProgressUpdate({ timeout: 600 }, 2, 1_000, 31_000);
    expect(update).toMatchObject({
      kind: 'status',
      replace: true,
      text: 'Waiting 30s / 10m · 2 background tasks still running',
      fields: { wait: { elapsedS: 30, timeoutS: 600, runningCount: 2 } },
    });
    expect(waitForProgressUpdate({ timeout: 600 }, 1, 1_000, 31_000).text).toContain(
      '1 background task still running',
    );
    expect(waitForProgressUpdate({ timeout: 600 }, 0, 1_000, 31_000).text).toContain(
      '0 background tasks still running',
    );
    expect(waitForProgressUpdate({ timeout: 600 }, 1, 1_000, 76_000).text).toContain(
      'Waiting 1m 15s / 10m',
    );
    expect(waitForProgressUpdate({ timeout: 180 }, 1, 1_000, 61_000).text).toContain(
      'Waiting 1m / 3m',
    );
  });

  it('exposes the composed progress through handler fields on a manual tick', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-prog002' }));
    const handler = new HandlerToolExecutor([
      new LegacyExecutableToolAdapter({
        name: 'WaitFor',
        description: 'WaitFor',
        parameters: {},
        resolveExecution: () => ({
          approvalRule: 'WaitFor',
          execute: async (ctx) => {
            const progress = startWaitProgress({ timeout: 600 }, tasks, ctx.onUpdate, Date.now() - 30_000);
            progress.tick();
            progress.stop();
            return { output: 'done' };
          },
        }),
      }),
    ]).execute(
      { type: 'function', id: 'wait-fields', name: 'WaitFor', arguments: '{}' },
      { turnId: 0 },
    );

    await handler.wait();

    expect(handler.fields()).toMatchObject({
      status: expect.stringMatching(/^Waiting 3\ds \/ 10m · 1 background task still running$/),
      statusReplace: true,
      wait: { elapsedS: expect.any(Number), timeoutS: 600, runningCount: 1 },
    });
  });
});

describe('WaitForTool (harness)', () => {
  function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from(stdoutText ? [stdoutText] : []),
      stderr: Readable.from([]),
      pid: 10000 + exitCode,
      exitCode,
      wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }

  async function waitForTerminal(tasks: IAgentTaskService, taskId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const info = await tasks.wait(taskId, 5);
      if (info !== undefined && TERMINAL_STATUSES.has(info.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for task to terminate: ${taskId}`);
  }

  it.each(['specific', 'any'] as const)('steers out of a running %s wait without losing tool history or stopping the background task', async (target) => {
    const ctx = createTestAgent();
    try {
      ctx.get(IAgentLoopService).update({ activeToolNames: ['TaskList', 'WaitFor'] });
      installControlledTask(ctx);
      await ctx.restorePersisted();
      const tasks = ctx.get(IAgentTaskService);
      const controlled = await startControlledTaskInLoop(ctx, { description: 'background work' });
      const baselineLlmCalls = ctx.llmCalls.length;
      const taskId = controlled.handler.taskId;
      ctx.mockNextResponse(
        { type: 'function', id: 'list-before-wait', name: 'TaskList', arguments: '{}' },
        { type: 'function', id: 'wait-for-task', name: 'WaitFor', arguments: JSON.stringify({ timeout: 90, task_id: target === 'specific' ? taskId : undefined }) },
      );
      ctx.mockNextResponse({ type: 'text', text: 'Handling the new request.' });

      const waiting = createControlledPromise<void>();
      ctx.get(IEventBus).subscribe(ToolUpdated, (event) => {
        if (event.fields['wait'] !== undefined) waiting.resolve();
      });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for the background work.' }] });
      await waiting;
      await ctx.rpc.steer({ input: [{ type: 'text', text: 'Handle this new request first.' }] });

      await vi.waitFor(() => {
        expect(ctx.llmCalls).toHaveLength(baselineLlmCalls + 2);
      }, { timeout: 1_000 });
      const history = ctx.llmCalls[baselineLlmCalls + 1]!.history;
      expect(history.filter((message) =>
        message.role === 'tool' && (message.toolCallId === 'list-before-wait' || message.toolCallId === 'wait-for-task')
      )).toMatchObject([
        { toolCallId: 'list-before-wait', content: [{ type: 'text', text: expect.stringContaining(taskId) }] },
        { toolCallId: 'wait-for-task', content: [{ type: 'text', text: expect.stringContaining('wait_status: interrupted') }] },
      ]);
      expect(history.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'Handle this new request first.' }],
      });
      expect(ctx.allEvents).not.toContainEqual(expect.objectContaining({
        event: 'tool.result',
        args: expect.objectContaining({ toolCallId: 'wait-for-task', isError: true }),
      }));
      expect(tasks.getTask(taskId)?.status).toBe('running');
      await ctx.get(IAgentLoopService).settled();
      ctx.mockNextResponse({ type: 'text', text: 'The background work has finished.' });
      const notified = vi.waitFor(() => expect(taskNotifications(ctx, taskId)).toHaveLength(1));
      controlled.resolve('');
      await notified;
      await ctx.get(IAgentLoopService).settled();
      expect(tasks.getTask(taskId)?.status).toBe('completed');
      expect(taskNotifications(ctx, taskId)).toHaveLength(1);
      await ctx.expectResumeMatches();
    } finally {
      await Promise.all(
        ctx.get(IAgentToolExecutorService).handlers().map((handler) => handler.stop('test cleanup')),
      );
      await ctx.dispose();
    }
  });

  it.each(['before-request', 'before-tool'] as const)('interrupts every wait after %s steering and can wait again after consuming the new input', async (timing) => {
    const ctx = createTestAgent();
    try {
      ctx.get(IAgentLoopService).update({ activeToolNames: ['WaitFor'] });
      installControlledTask(ctx);
      await ctx.restorePersisted();
      const tasks = ctx.get(IAgentTaskService);
      const controlled = await startControlledTaskInLoop(ctx, { description: 'background work' });
      const taskId = controlled.handler.taskId;
      ctx.mockNextResponse(
        { type: 'function', id: 'wait-specific', name: 'WaitFor', arguments: JSON.stringify({ timeout: 90, task_id: taskId }) },
        { type: 'function', id: 'wait-any', name: 'WaitFor', arguments: '{"timeout":90}' },
      );
      ctx.mockNextResponse({
        type: 'function', id: 'wait-again', name: 'WaitFor',
        arguments: JSON.stringify({ timeout: 90, task_id: taskId }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'The background work has finished.' });
      const steer = async () => {
        await ctx.rpc.steer({ input: [{ type: 'text', text: 'Check this message before waiting again.' }] });
        await ctx.rpc.steer({ input: [{ type: 'text', text: 'Keep the background task running.' }] });
      };
      if (timing === 'before-request') {
        let steered = false;
        ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('steer-before-request', async (event, next) => {
          if (event.step === 1 && !steered) {
            steered = true;
            void steer();
          }
          await next();
        });
      } else {
        ctx.get(IAgentToolExecutorService).registerHook({
          beforeExecute: (event) => {
            if (event.call.id === 'wait-specific') void steer();
          },
        });
      }
      const waitingAgain = createControlledPromise<void>();
      ctx.get(IEventBus).subscribe(ToolUpdated, (event) => {
        if (event.toolCallId === 'wait-again' && event.fields['wait'] !== undefined) waitingAgain.resolve();
      });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for the background work.' }] });
      if (timing === 'before-request') {
        controlled.resolve('');
        await ctx.get(IAgentLoopService).settled();
      } else {
        await waitingAgain;
      }

      const resumed = ctx.llmCalls.find((call) =>
        call.history.some((entry) => entry.role === 'tool' && entry.toolCallId === 'wait-specific') &&
        call.history.some((entry) => entry.role === 'user' && entry.content.some((part) => part.type === 'text' && part.text === 'Keep the background task running.')),
      );
      const specificStatus = timing === 'before-request' ? 'completed' : 'interrupted';
      const anyStatus = timing === 'before-request' ? 'no_tasks' : 'interrupted';
      expect(resumed?.history.filter((message) => message.role === 'tool' && (message.toolCallId === 'wait-specific' || message.toolCallId === 'wait-any'))).toMatchObject([
        { toolCallId: 'wait-specific', content: [{ text: expect.stringContaining(`wait_status: ${specificStatus}`) }] },
        { toolCallId: 'wait-any', content: [{ text: expect.stringContaining(`wait_status: ${anyStatus}`) }] },
      ]);
      expect(resumed?.history.filter((message) => message.role === 'user').slice(-2)).toMatchObject([
        { role: 'user', content: [{ text: 'Check this message before waiting again.' }] },
        { role: 'user', content: [{ text: 'Keep the background task running.' }] },
      ]);
      expect(tasks.getTask(taskId)?.status).toBe(timing === 'before-request' ? 'completed' : 'running');
      if (timing === 'before-tool') controlled.resolve('');
      await ctx.get(IAgentLoopService).settled();
      expect(ctx.llmCalls.at(-1)?.history.find((message) => message.role === 'tool' && message.toolCallId === 'wait-again')).toMatchObject({
        content: [{ text: expect.stringContaining('wait_status: completed') }],
      });
      expect(taskNotifications(ctx, taskId)).toHaveLength(1);
      await ctx.expectResumeMatches();
    } finally {
      await Promise.all(
        ctx.get(IAgentToolExecutorService).handlers().map((handler) => handler.stop('test cleanup')),
      );
      await ctx.dispose();
    }
  });

  it.each(['steer-first', 'completion-first'] as const)('reports task completion through wait and notification when it races with steering (%s)', async (order) => {
    const ctx = createTestAgent();
    try {
      ctx.get(IAgentLoopService).update({ activeToolNames: ['WaitFor'] });
      installControlledTask(ctx);
      await ctx.restorePersisted();
      const tasks = ctx.get(IAgentTaskService);
      const controlled = await startControlledTaskInLoop(ctx, { description: 'background work' });
      const taskId = controlled.handler.taskId;
      ctx.mockNextResponse({
        type: 'function', id: 'racing-wait', name: 'WaitFor',
        arguments: JSON.stringify({ timeout: 90, task_id: taskId }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Handling the new request.' });
      ctx.mockNextResponse({ type: 'text', text: 'The background work has finished.' });
      const waiting = createControlledPromise<void>();
      ctx.get(IEventBus).subscribe(ToolUpdated, (event) => {
        if (event.fields['wait'] !== undefined) waiting.resolve();
      });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for the background work.' }] });
      await waiting;

      controlled.write('BACKGROUND-RESULT');
      if (order === 'completion-first') controlled.resolve('');
      const steered = ctx.rpc.steer({ input: [{ type: 'text', text: 'Handle the new request too.' }] });
      if (order === 'steer-first') controlled.resolve('');
      await steered;
      await waitForTerminal(tasks, taskId);
      await vi.waitFor(() => {
        const notifications = ctx.context.history().filter((message) =>
          message.origin?.kind === 'task' && message.origin.taskId === taskId,
        );
        expect(notifications).toHaveLength(1);
      });
      await ctx.get(IAgentLoopService).settled();

      const history = ctx.context.history();
      expect(taskNotifications(ctx, taskId)).toHaveLength(1);
      expect(await tasks.readOutput(taskId)).toBe('BACKGROUND-RESULT');
      expect(history.filter((message) => message.content.some((part) =>
        part.type === 'text' && part.text === 'Handle the new request too.',
      ))).toHaveLength(1);
      expect(tasks.getTask(taskId)?.status).toBe('completed');
      await ctx.expectResumeMatches();
    } finally {
      await Promise.all(
        ctx.get(IAgentToolExecutorService).handlers().map((handler) => handler.stop('test cleanup')),
      );
      await ctx.dispose();
    }
  });

  it('still cancels a wait when execution is aborted together with steering', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const controlled = await startControlledTaskInLoop(ctx, { description: 'background work' });
      const taskId = controlled.handler.taskId;
      const cancelled = new AbortController();
      const steered = new AbortController();
      const pending = executeTool(ctx.get(IWaitForTool), {
        ...context('cancelled-wait', { timeout: 90, task_id: taskId }, cancelled.signal),
        steerSignal: steered.signal,
      });
      cancelled.abort(new Error('Aborted'));
      steered.abort();

      await expect(pending).rejects.toThrow('Aborted');
      expect(tasks.getTask(taskId)?.status).toBe('running');
    } finally {
      await Promise.all(
        ctx.get(IAgentToolExecutorService).handlers().map((handler) => handler.stop('test cleanup')),
      );
      await ctx.dispose();
    }
  });

  it('waits for a real registered task end-to-end without suppressing its notification', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('WaitFor');
      expect(tool).toBeDefined();

      const controlled = await startControlledTaskInLoop(ctx, { description: 'wait target' });
      const taskId = controlled.handler.taskId;
      const pending = executeTool(tool!, context('wait_e2e', { timeout: 30, task_id: taskId }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const requestsBeforeCompletion = ctx.llmCalls.length;
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      controlled.write('DONE-OUTPUT\n');
      controlled.resolve('');
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskId}`);
      expect(output).toContain('[finished]');
      expect(output).not.toContain('[output]\nDONE-OUTPUT');
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(false);

      await vi.waitFor(() => expect(taskNotifications(ctx, taskId)).toHaveLength(1));
      await ctx.get(IAgentLoopService).settled();
      expect(taskNotifications(ctx, taskId)).toHaveLength(1);
      expect(await tasks.readOutput(taskId)).toBe('DONE-OUTPUT\n');
      expect(ctx.llmCalls).toHaveLength(requestsBeforeCompletion + 1);
      expect(
        records.findLast((record) => record.event === 'wait_for_completed')?.properties,
      ).toMatchObject({ outcome: 'completed', has_task_id: true, extra_completed_count: 0 });
    } finally {
      await ctx.dispose();
    }
  });

  it('does not include tasks registered after the wait started', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('WaitFor');
      expect(tool).toBeDefined();

      const taskAControlled = await startControlledTaskInLoop(ctx, { description: 'slow' });
      const taskA = taskAControlled.handler.taskId;
      const pending = executeTool(tool!, context('wait_race', { timeout: 30 }));

      const taskBControlled = await startControlledTaskInLoop(ctx, { description: 'late comer' });
      const taskB = taskBControlled.handler.taskId;
      taskBControlled.write('B-OUT\n');
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      taskBControlled.resolve('');
      await waitForTerminal(tasks, taskB);

      const race = await Promise.race([
        pending.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ]);
      expect(race).toBe('pending');

      taskAControlled.write('A-OUT\n');
      taskAControlled.resolve('');
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskA}`);
      expect(output).not.toContain(taskB);
      expect(output).not.toContain('[completed_during_wait]');
      await ctx.persistedWireRecords();
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(false);
      await vi.waitFor(() => {
        expect(taskNotifications(ctx, taskA)).toHaveLength(1);
        expect(taskNotifications(ctx, taskB)).toHaveLength(1);
      });
      await ctx.get(IAgentLoopService).settled();
      expect(taskNotifications(ctx, taskA)).toHaveLength(1);
      expect(taskNotifications(ctx, taskB)).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  });

  it('returns from a wait on a task that never settles once the timeout elapses', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IWaitForTool);
      const controlled = await startControlledTaskInLoop(ctx, { description: 'hung work' });
      const taskId = controlled.handler.taskId;

      const result = await executeTool(tool, context('wait_hang', { timeout: 1, task_id: taskId }));
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: timed_out');
      expect(output).toContain('[still_running]');
      expect(output).toContain(taskId);
    } finally {
      await ctx.dispose();
    }
  });
});
