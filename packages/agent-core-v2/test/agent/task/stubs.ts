import { join } from 'pathe';

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

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_SESSION_SCOPE),
    TASK_TEST_SESSION_SCOPE,
    new JsonAtomicDocumentStore(storage),
    storage,
  );
}
