/**
 * Covers: TaskListTool, TaskOutputTool, TaskStopTool.
 */

import { describe, expect, it, vi } from 'vitest';

import { abortable, userCancellationReason } from '#/_base/utils/abort';
import type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
  AgentTaskTrackOptions,
  ForegroundTaskReleaseReason,
  IAgentTaskEntry,
  IAgentTaskService,
  RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import {
  TaskListInputSchema,
  TaskListTool,
} from '#/agent/task/tools/task-list';
import {
  TaskOutputInputSchema,
  TaskOutputTool,
} from '#/agent/task/tools/task-output';
import {
  TaskStopInputSchema,
  TaskStopTool,
} from '#/agent/task/tools/task-stop';
import type { ITaskHandle } from '#/app/task/task';
import type { ProcessTaskInfo } from '#/os/backends/node-local/tools/process-task';
import type { SubagentTaskInfo } from '#/session/agentLifecycle/tools/subagent-task';
import { TaskListTool as V1TaskListTool } from '../../../../../agent-core/src/tools/background/task-list';
import { TaskOutputTool as V1TaskOutputTool } from '../../../../../agent-core/src/tools/background/task-output';
import { TaskStopTool as V1TaskStopTool } from '../../../../../agent-core/src/tools/background/task-stop';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(
  toolCallId: string,
  args: Input,
  executionSignal: AbortSignal = signal,
) {
  return { turnId: 0, toolCallId, args, signal: executionSignal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

interface ModelFacingToolContract {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

function expectModelFacingParity(
  actual: ModelFacingToolContract,
  expected: ModelFacingToolContract,
): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.description).toBe(expected.description);
  expect(JSON.stringify(actual.parameters)).toBe(JSON.stringify(expected.parameters));
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
  wait?: (
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
}

class FakeTaskService implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  readonly stopCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  readonly suppressCalls: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];

  private readonly entries = new Map<string, FakeTaskEntry>();

  add(
    info: AgentTaskInfo,
    output: AgentTaskOutputSnapshot = outputSnapshot(),
    wait?: (
      timeoutMs: number | undefined,
      signal: AbortSignal | undefined,
    ) => Promise<void>,
  ): string {
    this.entries.set(info.taskId, { info, output, wait });
    return info.taskId;
  }

  track(_handle: ITaskHandle, _options: AgentTaskTrackOptions): IAgentTaskEntry {
    throw new Error('track is not implemented in FakeTaskService.');
  }

  registerTask(_task: AgentTask, _options?: RegisterAgentTaskOptions): string {
    throw new Error('registerTask is not implemented in FakeTaskService.');
  }

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

  async getOutputSnapshot(
    taskId: string,
    _maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    return this.entries.get(taskId)?.output ?? outputSnapshot();
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const preview = this.entries.get(taskId)?.output.preview ?? '';
    if (tail === undefined) return preview;
    return preview.slice(-Math.max(0, Math.trunc(tail)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressCalls.push(taskId);
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      terminalNotificationSuppressed: true,
    } as AgentTaskInfo;
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
    const entry = this.entries.get(taskId);
    await entry?.wait?.(timeoutMs, signal);
    return entry?.info;
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    return this.entries.has(taskId) ? 'detached' : undefined;
  }
}

describe('TaskListTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskListTool(new FakeTaskService());

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
      new TaskListTool(new FakeTaskService()),
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
      new TaskListTool(tasks),
      context('task_list_active', { active_only: true }),
    );
    const output = outputString(result);

    expect(output).toMatch(/^active_background_tasks:\s*1/);
    expect(output).toContain('kind: process');
    expect(output).toContain('task_id: bash-running1');
    expect(output).toContain('command: sleep 60');
    expect(output).toContain('description: running list');
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
        new TaskListTool(tasks),
        context('task_list_active_terminal', { active_only: true }),
      );
      expect(outputString(active)).toContain(
        'active_background_tasks: 0\nNo background tasks found.',
      );

      const all = await executeTool(
        new TaskListTool(tasks),
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
      new TaskListTool(tasks),
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
      new TaskListTool(tasks),
      context('task_list_stop_reason', { active_only: false }),
    );

    expect(outputString(result)).toContain('stop_reason: superseded by newer task');
  });

  it('does not wait when listing a running task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running2', description: 'running task' }));
    const wait = vi.spyOn(tasks, 'wait');

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_no_wait', { active_only: true }),
    );

    expect(outputString(result)).toContain('running task');
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('TaskOutputTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskOutputTool(new FakeTaskService());

    expect(tool.name).toBe('TaskOutput');
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(
      TaskOutputInputSchema.safeParse({ task_id: 'bash-1', block: true, timeout: 0 }).success,
    ).toBe(true);
    expect(
      TaskOutputInputSchema.safeParse({ task_id: 'bash-1', timeout: 3601 }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        block: { type: 'boolean' },
        timeout: { type: 'integer' },
      },
    });
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskOutputTool(new FakeTaskService()),
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
      new TaskOutputTool(tasks),
      context('task_output_live', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(result).toMatchObject({ isError: false, message: 'Task snapshot retrieved.' });
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
      new TaskOutputTool(tasks),
      context('task_output_persisted', { task_id: taskId, block: true }),
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
      new TaskOutputTool(tasks),
      context('task_output_agent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('kind: agent');
    expect(output).toContain('agent_id: agent-child');
    expect(output).toContain('subagent_type: coder');
    expect(output).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(output).not.toMatch(/^pid:/m);
    expect(output).not.toMatch(/^command:/m);
    expect(output).not.toMatch(/^exit_code:/m);
  });

  it('returns not_ready for non-blocking running tasks', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-running3' }));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_not_ready', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('retrieval_status: not_ready');
    expect(output).toContain('status: running');
    expect(output).not.toContain('next_step');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('returns timeout for block=true when a running task does not finish', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-running4' }));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_timeout', { task_id: taskId, block: true, timeout: 1 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('retrieval_status: timeout');
    expect(output).toContain('status: running');
    expect(output).toContain('next_step:');
    expect(output).toContain('Do not block on it again');
    expect(tasks.waitCalls).toEqual([{ taskId, timeoutMs: 1_000 }]);
  });

  it('cancels a blocking read when the tool execution signal aborts', async () => {
    const tasks = new FakeTaskService();
    let markWaitStarted: () => void = () => {};
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const taskId = tasks.add(
      processTask({ taskId: 'bash-cancel01' }),
      outputSnapshot(),
      (_timeoutMs, waitSignal) => {
        markWaitStarted();
        if (waitSignal === undefined) throw new Error('Missing tool execution signal.');
        return abortable(new Promise<void>(() => {}), waitSignal);
      },
    );
    const controller = new AbortController();
    const execution = executeTool(
      new TaskOutputTool(tasks),
      context(
        'task_output_cancelled',
        { task_id: taskId, block: true, timeout: 60 },
        controller.signal,
      ),
    );
    await waitStarted;
    const reason = userCancellationReason();

    controller.abort(reason);

    await expect(execution).rejects.toBe(reason);
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
      new TaskOutputTool(tasks),
      context('task_output_timed_out', { task_id: taskId, block: true }),
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
      new TaskOutputTool(tasks),
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
      new TaskOutputTool(tasks),
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
      new TaskOutputTool(tasks),
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
    const tool = new TaskStopTool(new FakeTaskService());

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
      new TaskStopTool(new FakeTaskService()),
      context('task_stop_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  });

  it('stops a running task, records the reason, and suppresses terminal notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-stop0001' }));

    const result = await executeTool(
      new TaskStopTool(tasks),
      context('task_stop_running', { task_id: taskId, reason: 'custom stop reason' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('task_id: bash-stop0001');
    expect(output).toContain('status: killed');
    expect(output).toContain('reason: custom stop reason');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'custom stop reason' }]);
    expect(tasks.suppressCalls).toEqual([taskId]);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'killed',
      stopReason: 'custom stop reason',
      terminalNotificationSuppressed: true,
    });
  });

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-default1' }));

    const result = await executeTool(
      new TaskStopTool(tasks),
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
      new TaskStopTool(tasks),
      context('task_stop_terminal', { task_id: taskId }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')).toEqual([
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(tasks.suppressCalls).toEqual([]);
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
      new TaskStopTool(tasks),
      context('task_stop_blank_stored_reason', { task_id: 'bash-blank001' }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')[2]).toBe(
      'reason: Task already in terminal state',
    );
  });
});

describe('task tool descriptions', () => {
  const tasks = new FakeTaskService();

  it('matches the v1 model-facing contract exactly', () => {
    expectModelFacingParity(new TaskListTool(tasks), new V1TaskListTool({} as never));
    expectModelFacingParity(new TaskOutputTool(tasks), new V1TaskOutputTool({} as never));
    expectModelFacingParity(new TaskStopTool(tasks), new V1TaskStopTool({} as never));
  });

  it('TaskOutput description mentions background tasks, block, output_path, and Read', () => {
    const description = new TaskOutputTool(tasks).description;

    expect(description).toMatch(/background/i);
    expect(description).toMatch(/block/);
    expect(description).toMatch(/output_path/);
    expect(description).toMatch(/Read/);
    expect(description).toContain('run that task in the foreground instead');
    expect(description).toContain('exit_code');
    expect(description).toContain('`failed`');
  });

  it('TaskList description mentions active_only default, read-only, and plan-mode safety', () => {
    const description = new TaskListTool(tasks).description;

    expect(description).toMatch(/active_only/);
    expect(description).toMatch(/read[- ]only/i);
    expect(description).toMatch(/plan[- ]mode/i);
    expect(description).toMatch(/background tasks?/i);
  });

  it('TaskStop description clarifies destructive cancellation and generic behavior', () => {
    const description = new TaskStopTool(tasks).description;

    expect(description).toMatch(/destructive/i);
    expect(description).toMatch(/cancel/i);
    expect(description).toMatch(/general[-\s]?purpose|generic/i);
    expect(description).not.toMatch(/bash[- ]?only/i);
  });
});
