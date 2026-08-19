import { PassThrough, Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskTrackOptions,
  type AgentTaskWaitDelivery,
  type ForegroundTaskReleaseReason,
  type IAgentTaskEntry,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
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
import type { ITaskHandle } from '#/app/task/task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import { ProcessTask, type ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import { IWaitForTool } from '#/agent/tools/task/task-wait/task-wait';
import { IAgentLoopService } from '#/agent/loop/loop';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../../../app/telemetry/stubs';
import { stubFlag } from '../../../app/flag/stubs';
import { agentService, createTestAgent, telemetryServices } from '../../../harness';
import { stubLoopWithHooks } from '../../loop/stubs';

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
}

class FakeTaskService implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  readonly stopCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  readonly suppressCalls: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];
  readonly waitDeliveries: Array<readonly AgentTaskWaitDelivery[]> = [];
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
    this.entries.set(info.taskId, { info, output });
    return info.taskId;
  }

  settle(taskId: string, status: AgentTaskStatus = 'completed'): void {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      status,
      endedAt: entry.info.endedAt ?? 1_700_000_002_000,
    } as AgentTaskInfo;
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

  async suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressCalls.push(taskId);
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      terminalNotificationSuppressed: true,
    } as AgentTaskInfo;
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    this.waitDeliveries.push(tasks);
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
      new TaskOutputTool(tasks),
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

  it('rejects stale block/timeout args at the validator instead of waiting', () => {
    const validator = compileToolArgsValidator(new TaskOutputTool(new FakeTaskService()).parameters);

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
      new TaskOutputTool(tasks),
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

describe('WaitForTool', () => {
  function waitTelemetry(): { records: TelemetryRecord[]; telemetry: ReturnType<typeof recordingTelemetry> } {
    const records: TelemetryRecord[] = [];
    return { records, telemetry: recordingTelemetry(records) };
  }

  function lastEvent(records: TelemetryRecord[]): TelemetryRecord | undefined {
    return records.findLast((record) => record.event === 'wait_for_completed');
  }

  it('has name and accepts the current schema', () => {
    const tool = new WaitForTool(new FakeTaskService(), recordingTelemetry([]), stubFlag(true));

    expect(tool.name).toBe('WaitFor');
    expect(WaitForInputSchema.safeParse({ timeout: 60 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 60, task_id: 'bash-1' }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({ timeout: 600 }).success).toBe(true);
    expect(WaitForInputSchema.safeParse({}).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: -5 }).success).toBe(false);
    expect(WaitForInputSchema.safeParse({ timeout: 601 }).success).toBe(false);
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
      new WaitForTool(new FakeTaskService(), telemetry, stubFlag(true)),
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
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_none', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: no_tasks');
    expect(output).toContain('No background tasks are running');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('returns a finished task immediately and marks it delivered via wait', async () => {
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
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_done', { timeout: 10, task_id: taskId }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('status: completed');
    expect(output).toContain('[finished]');
    expect(output).toContain('[output]\nDONE-OUTPUT');
    expect(tasks.waitDeliveries).toEqual([[{ taskId, status: 'completed' }]]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: true,
      extra_completed_count: 0,
    });
  });

  it('reports tasks that finished during the wait and marks all of them delivered', async () => {
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
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_extras', { timeout: 10, task_id: 'bash-wait001' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('[completed_during_wait]');
    expect(output).toContain('task_id: bash-extra001');
    expect(output).toContain('status: failed');
    expect(tasks.waitDeliveries).toEqual([
      [
        { taskId: 'bash-wait001', status: 'completed' },
        { taskId: 'bash-extra001', status: 'failed' },
      ],
    ]);
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
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_any', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('task_id: bash-a1');
    expect(output).toContain('[output]\nA-OUT');
    expect(output).toContain('[still_running]');
    expect(output).toContain('task_id: bash-b1');
    expect(tasks.waitCalls).toHaveLength(2);
    expect(tasks.waitDeliveries).toEqual([[{ taskId: 'bash-a1', status: 'completed' }]]);
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
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_timeout', { timeout: 10, task_id: 'bash-running9' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: timed_out');
    expect(output).toContain('not an error');
    expect(output).toContain('[still_running]');
    expect(output).toContain('bash-running9');
    expect(tasks.waitDeliveries).toEqual([]);
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
      new WaitForTool(tasks, telemetry, stubFlag(true)),
      context('wait_abort', { timeout: 600, task_id: 'bash-abort01' }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.waitDeliveries).toEqual([]);
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
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_abort_any', { timeout: 600 }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.getTask('bash-abort02')?.status).toBe('running');
    expect(tasks.getTask('bash-abort03')?.status).toBe('running');
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it('does not mark tasks delivered when formatting the result fails', async () => {
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

    await expect(
      executeTool(
        new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
        context('wait_fmt_fail', { timeout: 10, task_id: taskId }),
      ),
    ).rejects.toThrow('snapshot read failed');
    expect(tasks.waitDeliveries).toEqual([]);
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
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_losers', { timeout: 600 }),
    );

    expect(outputString(result)).toContain('wait_status: completed');
    expect(signals.get('bash-lose001')?.aborted).toBe(true);
  });

  it('rejects execution when the wait_for flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-flagoff1' }));

    const result = await executeTool(
      new WaitForTool(tasks, recordingTelemetry([]), stubFlag(false)),
      context('wait_flag_off', { timeout: 10, task_id: 'bash-flagoff1' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('wait_for experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  });

  it('emits status progress updates while the wait is pending', async () => {
    const update = waitForProgressUpdate({ timeout: 600 }, 2, 1_000, 31_000);
    expect(update).toMatchObject({
      kind: 'status',
      replace: true,
      text: 'Waiting 30s / 10m · 2 background tasks still running',
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

  it('routes the composed progress update through onUpdate on a manual tick', () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-prog002' }));
    const onUpdate = vi.fn();

    const progress = startWaitProgress({ timeout: 600 }, tasks, onUpdate, Date.now() - 30_000);
    progress.tick();
    progress.stop();

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'status',
        replace: true,
        text: expect.stringMatching(/^Waiting 3\ds \/ 10m · 1 background task still running$/),
      }),
    );
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

  function controllableProcess(): {
    proc: IHostProcess;
    pushOutput: (text: string) => void;
    resolveWait: (code: number) => void;
  } {
    const stdout = new PassThrough();
    let resolveWait!: (code: number) => void;
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid: 10099,
      exitCode: null,
      wait: vi.fn(() => waitPromise) as IHostProcess['wait'],
      kill: vi.fn(async () => {
        stdout.destroy();
        resolveWait(143);
      }) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    } as IHostProcess;
    return {
      proc,
      pushOutput: (text) => {
        stdout.write(text);
      },
      resolveWait: (code) => {
        stdout.end();
        resolveWait(code);
      },
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

  it('waits for a real registered task end-to-end and suppresses its notification', async () => {
    const records: TelemetryRecord[] = [];
    const loop = stubLoopWithHooks();
    const ctx = createTestAgent(
      telemetryServices(recordingTelemetry(records)),
      agentService(IAgentLoopService, loop),
    );
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('WaitFor');
      expect(tool).toBeDefined();

      const slow = controllableProcess();
      const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'echo done', 'wait target'));
      const pending = executeTool(tool!, context('wait_e2e', { timeout: 30, task_id: taskId }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      slow.pushOutput('DONE-OUTPUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskId}`);
      expect(output).toContain('[finished]');
      expect(output).toContain('[output]\nDONE-OUTPUT');
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(true);

      expect(loop.hasPendingRequests()).toBe(false);
      loop.drainNextBatch(ctx.context);
      expect(ctx.context.get().some((message) => message.origin?.kind === 'task')).toBe(false);
      expect(ctx.allEvents.some((event) => event.event === 'task.notified')).toBe(false);
      expect(ctx.llmCalls).toHaveLength(0);
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

      const slow = controllableProcess();
      const taskA = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 30', 'slow'));
      const pending = executeTool(tool!, context('wait_race', { timeout: 30 }));

      const late = controllableProcess();
      const taskB = tasks.registerTask(new ProcessTask(late.proc, 'echo b', 'late comer'));
      await tasks.suppressTerminalNotification(taskB);
      late.pushOutput('B-OUT\n');
      late.resolveWait(0);
      await waitForTerminal(tasks, taskB);

      const race = await Promise.race([
        pending.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ]);
      expect(race).toBe('pending');

      slow.pushOutput('A-OUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskA}`);
      expect(output).not.toContain(taskB);
      expect(output).not.toContain('[completed_during_wait]');
      expect(ctx.allEvents.filter((event) => event.event === 'task.waitDelivered')).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  });

  it('returns from a wait on a task that never settles once the timeout elapses', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IWaitForTool);
      const taskId = tasks.registerTask(
        new SubagentTask(
          {
            agentId: 'agent-hang',
            profileName: 'coder',
            completion: new Promise<{ result: string }>(() => {}),
          },
          'hung work',
          new AbortController(),
        ),
      );

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
