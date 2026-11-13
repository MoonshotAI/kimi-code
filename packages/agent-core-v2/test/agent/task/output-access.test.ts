import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IReadTool } from '#/agent/tools/os/read/read';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { createMapFs, stubPlanEnvironment } from '../../features/plan/stubs';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import {
  AgentTaskRequestService,
  AgentTaskService,
  type IAgentTaskHistoryService,
} from '#/agent/task/taskService';
import {
  createAgentTaskPersistence,
  createTaskChannel,
  startControlledTask,
  taskHistoryRecords,
  type TaskChannel,
} from './stubs';
import { agentService, taskServices, createTestAgent, homeDirServices } from '../../harness';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';

interface TaskServiceFixture {
  readonly channel: TaskChannel;
  readonly manager: IAgentTaskService;
  readonly persistence: ReturnType<typeof createAgentTaskPersistence>;
}

function createTaskService(homedir: string): TaskServiceFixture {
  const persistence = createAgentTaskPersistence(homedir);
  const channel = createTaskChannel({ persistence });
  return { channel, manager: channel.service, persistence };
}

function restoredTaskService(channel: TaskChannel, infos: readonly AgentTaskInfo[]) {
  const reduced = new AgentTaskService('main');
  reduced.restore(taskHistoryRecords(infos));
  const history: IAgentTaskHistoryService = {
    _serviceBrand: undefined,
    getTask: (taskId) => reduced.get(taskId),
    list: (activeOnly, limit) => reduced.list(activeOnly, limit),
    values: () => reduced.values(),
    reconcile: async () => {},
  };
  return {
    history,
    manager: new AgentTaskRequestService(channel.toolExecutor, history, channel.outputs),
  };
}

async function registerProcess(channel: TaskChannel, output: string, description: string): Promise<string> {
  const task = await startControlledTask(channel, {
    description,
    output,
    completion: Promise.resolve(''),
  });
  return task.handler.taskId;
}

function toolContext<Input>(toolCallId: string, args: Input): TestExecutableToolContext<Input> {
  return { turnId: 0, toolCallId, args, signal: new AbortController().signal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

async function waitForOutput(manager: IAgentTaskService, taskId: string, expected: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

describe('AgentTaskService — readOutput / getOutputSnapshot', () => {
  let sessionDir: string;
  let fixture: TaskServiceFixture;
  let manager: IAgentTaskService;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    fixture = createTaskService(sessionDir);
    manager = fixture.manager;
    persistence = fixture.persistence;
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('getOutputSnapshot returns output.log path when persisted output exists', async () => {
    const taskId = await registerProcess(fixture.channel, 'hello\n', 'demo');

    await waitForOutput(manager, taskId, 'hello');
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);
    await manager.wait(taskId);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputPath).toContain(sessionDir);
    expect(snapshot.outputPath).toContain(taskId);
    expect(snapshot.outputPath!.endsWith('output.log')).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
  });

  it('reads the actual server-local fallback under a remote binding without exposing unrelated host files', async () => {
    const remoteFiles = new Map<string, string>();
    const remoteFs = createMapFs(remoteFiles, {
      mkdir: async () => { throw new Error('remote offline'); },
      writeText: async () => { throw new Error('remote offline'); },
      appendText: async () => { throw new Error('remote offline'); },
    });
    const environment = stubPlanEnvironment({ fs: remoteFs, tempDir: '/remote/tmp' });
    const remoteCtx = createTestAgent([
      homeDirServices(join(sessionDir, 'remote-home')),
      taskServices(),
      agentService(IAgentEnvironmentService, environment),
    ]);
    const remoteFixture = createTaskService(join(sessionDir, 'remote-home'));
    const remoteManager = remoteFixture.manager;
    try {
      const id = await registerProcess(remoteFixture.channel, 'retained local output\n', 'demo');
      await remoteManager.wait(id);
      const snapshot = await remoteManager.getOutputSnapshot(id, 1_000);
      expect(snapshot.outputPath).toBe(join(remoteCtx.get(ISessionContext).sessionDir, 'agents', 'main', 'tasks', id, 'output.log'));
      const acquire = vi.spyOn(environment, 'acquire').mockImplementation(() => { throw new Error('remote disconnected'); });
      const read = remoteCtx.get(IReadTool);
      const result = await executeTool(read, toolContext('read_local_fallback', { path: snapshot.outputPath! }));
      expect(result.isError ?? false).toBe(false);
      expect(outputString(result)).toContain('retained local output');
      expect(acquire).not.toHaveBeenCalled();
      acquire.mockRestore();
      const current = remoteCtx.get(ISessionContext).sessionDir;
      const unrelated = [
        join(current, 'private.txt'),
        join(current, 'agents', 'another-agent', 'tasks', id, 'output.log'),
        join(current, '..', 'another-session', 'agents', 'main', 'tasks', id, 'output.log'),
      ];
      const host = remoteCtx.get(IHostFileSystem);
      for (const path of unrelated) {
        await host.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        await host.writeText(path, 'host secret');
        remoteFiles.set(path, 'remote counterpart');
        const other = await executeTool(read, toolContext('read_not_local', { path }));
        expect(outputString(other)).toContain('remote counterpart');
        expect(outputString(other)).not.toContain('host secret');
      }
    } finally {
      await remoteCtx.dispose();
    }
  });

  it('getOutputSnapshot truncates large persisted output to a tail preview with paging metadata', async () => {
    const head = 'HEAD-MARKER\n';
    const tail = 'TAIL-MARKER\n';
    const output = head + 'x'.repeat(200 * 1024) + tail;
    const taskId = await registerProcess(fixture.channel, output, 'large');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 32 * 1024);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength(output));
    expect(snapshot.previewBytes).toBe(32 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.preview).toContain(tail);
    expect(snapshot.preview).not.toContain(head);
  });

  it('getOutputSnapshot returns empty content without creating a log for a silent task', async () => {
    const taskId = await registerProcess(fixture.channel, '', 'silent task');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.preview).toBe('');
    expect(snapshot.outputSizeBytes).toBe(0);
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(false);
  });

  it('getOutputSnapshot returns an empty snapshot for unknown task ids', async () => {
    await expect(manager.getOutputSnapshot('bash-deadbeef', 1_000)).resolves.toEqual({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    });
  });

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = await registerProcess(fixture.channel, 'live content\n', 'demo');

    await waitForOutput(manager, taskId, 'live content');

    expect(await manager.readOutput(taskId)).toContain('live content');
    await manager.wait(taskId);
  });

  it('readOutput keeps earlier live chunks when more output is persisted', async () => {
    const taskId = await registerProcess(fixture.channel, 'ring-only\n', 'demo');

    await waitForOutput(manager, taskId, 'ring-only');
    await manager.wait(taskId);
    await persistence.appendTaskOutput(taskId, 'disk-only\n');

    const output = await manager.readOutput(taskId);
    expect(output).toContain('ring-only');
    expect(output).toContain('disk-only');
  });

  it('readOutput falls back to disk for historical tasks', async () => {
    const taskId = await registerProcess(fixture.channel, 'persisted line\n', 'demo');
    await waitForOutput(manager, taskId, 'persisted line');
    const info = await manager.wait(taskId);
    if (info === undefined) throw new Error('missing completed task');

    const freshFixture = createTaskService(sessionDir);
    const fresh = restoredTaskService(freshFixture.channel, [info]).manager;

    expect(await fresh.readOutput(taskId)).toContain('persisted line');
  });

  it('TaskOutputTool reads persisted output for a historical task loaded after restart', async () => {
    const taskId = await registerProcess(fixture.channel, 'persisted output\n', 'persist output test');
    await waitForOutput(manager, taskId, 'persisted output');
    const info = await manager.wait(taskId);
    if (info === undefined) throw new Error('missing completed task');

    const freshFixture = createTaskService(sessionDir);
    const fresh = restoredTaskService(freshFixture.channel, [info]);
    const result = await executeTool(
      new TaskOutputTool(freshFixture.channel.toolExecutor, fresh.history, freshFixture.channel.outputs),
      toolContext('task_output_restored', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('status: completed');
    expect(output).toContain('output_path:');
    expect(output).toContain('persisted output');
  });

  it('handler observation reports contiguous UTF-8 byte offsets', async () => {
    const chunks: { offset: number; text: string }[] = [];
    const output = '  VITE ready\n  ➜  Local: http://localhost:5173/\n';
    const controlled = await startControlledTask(fixture.channel, {
      description: 'dev server',
      completion: Promise.resolve(''),
    });
    const unobserve = controlled.handler.observe((event) => {
      if (event.type === 'output') chunks.push({ offset: event.offset, text: event.text });
    });
    controlled.write(output);
    controlled.resolve('');
    const taskId = controlled.handler.taskId;

    await manager.wait(taskId);
    unobserve();

    expect(chunks.map((chunk) => chunk.text).join('')).toBe(output);
    let expectedOffset = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(expectedOffset);
      expectedOffset += Buffer.byteLength(chunk.text, 'utf-8');
    }
    expect(expectedOffset).toBe(Buffer.byteLength(output, 'utf-8'));
  });

  it('readOutputTail returns the persisted tail bytes with their offset', async () => {
    const output = 'HEAD\n' + 'x'.repeat(200 * 1024) + '➜ TAIL\n';
    const taskId = await registerProcess(fixture.channel, output, 'large');

    await manager.wait(taskId);
    const tail = await manager.readOutputTail(taskId, 4096);

    const total = Buffer.byteLength(output, 'utf-8');
    expect(tail.offset).toBe(total - 4096);
    expect(tail.data.byteLength).toBe(4096);
    expect(Buffer.from(tail.data).toString('utf-8').endsWith('➜ TAIL\n')).toBe(true);
  });

  it('readOutputTail returns the complete tail for short output', async () => {
    const taskId = await registerProcess(fixture.channel, 'short ➜ line\n', 'demo');

    await waitForOutput(manager, taskId, 'short');
    const tail = await manager.readOutputTail(taskId, 4096);

    expect(tail.offset).toBe(0);
    expect(Buffer.from(tail.data).toString('utf-8')).toBe('short ➜ line\n');
    await manager.wait(taskId);
  });

  it('readOutputTail returns nothing for unknown task ids', async () => {
    const tail = await manager.readOutputTail('bash-deadbeef', 4096);

    expect(tail.offset).toBe(0);
    expect(tail.data.byteLength).toBe(0);
  });

  it('readOutput respects tail length', async () => {
    const taskId = await registerProcess(fixture.channel, 'aaaaa-bbbbb-ccccc-ddddd', 'demo');

    await waitForOutput(manager, taskId, 'ddddd');

    expect(await manager.readOutput(taskId, 5)).toBe('ddddd');
    await manager.wait(taskId);
  });

  it('readOutput returns the full output for a nonpositive tail', async () => {
    const taskId = await registerProcess(fixture.channel, 'aaaaa-bbbbb-ccccc-ddddd', 'demo');

    await waitForOutput(manager, taskId, 'ddddd');

    const full = await manager.readOutput(taskId);
    expect(await manager.readOutput(taskId, 0)).toBe(full);
    expect(await manager.readOutput(taskId, -7)).toBe(full);
    await manager.wait(taskId);
  });

  it('readOutput does not split a surrogate pair at the tail boundary', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const taskId = await registerProcess(fixture.channel, `aaaaa-bbbbb-${emoji}cc`, 'demo');

    await waitForOutput(manager, taskId, 'cc');

    expect(await manager.readOutput(taskId, 3)).toBe('cc');
    expect(await manager.readOutput(taskId, 2)).toBe('cc');
    expect(await manager.readOutput(taskId, 4)).toBe(`${emoji}cc`);
    await manager.wait(taskId);
  });
});
