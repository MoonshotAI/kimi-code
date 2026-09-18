import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  type IAgentTaskService,
} from '#/agent/task/task';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

export type TaskServiceTestManager = IAgentTaskService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly AgentTaskInfo[]>;
};

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    new JsonAtomicDocumentStore(storage),
    storage,
  );
}

export interface RecordingAppendWrite {
  readonly path: string;
  readonly data: string;
}

export function recordingAppendFs(writes: RecordingAppendWrite[]): IHostFileSystem {
  return {
    mkdir: async () => {},
    appendText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
  } as unknown as IHostFileSystem;
}
