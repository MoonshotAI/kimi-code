import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  type IAgentTaskService,
} from '#/agent/task/task';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { WireRecord } from '#/wire/record';

export type TaskServiceTestManager = IAgentTaskService;

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    storage,
  );
}

export function taskHistoryRecords(
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
): WireRecord[] {
  return infos.flatMap((info) => {
    const started = {
      type: TaskStarted.type,
      agentId,
      info: { ...info, status: 'running', endedAt: null },
    } as unknown as WireRecord;
    if (info.status === 'running') return [started];
    return [
      started,
      { type: TaskTerminated.type, agentId, info } as unknown as WireRecord,
    ];
  });
}

export async function restoreTaskHistory(
  ctx: { restore(records: readonly WireRecord[]): Promise<void> },
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
  preceding: readonly WireRecord[] = [],
): Promise<void> {
  await ctx.restore([...preceding, ...taskHistoryRecords(infos, agentId)]);
}

export interface RecordingAppendWrite {
  readonly path: string;
  readonly data: string;
}

export function recordingAppendFs(writes: RecordingAppendWrite[]): IHostFileSystem {
  return {
    mkdir: async () => {},
    writeText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
    appendText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
  } as unknown as IHostFileSystem;
}
