import { join } from 'pathe';

import type { AgentTaskInfo } from '#/features/task/types';
import { AgentTask, type TaskRuntime } from '#/features/task/taskAgentRuntime';
import { AgentTaskPersistence } from '#/features/task/internal/persist';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeProvider,
} from '#/agent/runtime/agentRuntime';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

export type TaskServiceTestManager = TaskRuntime & {
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

export function writeLegacyTaskFile(homedir: string, task: AgentTaskInfo): Promise<void> {
  const storage = new FileStorageService(homedir);
  const docs = new JsonAtomicDocumentStore(storage);
  return docs.set(`${TASK_TEST_AGENT_SCOPE}/tasks`, `${task.taskId}.json`, task);
}

export function stubTaskRuntimeProvider(
  runtime: () => Partial<TaskRuntime>,
): AgentRuntimeProvider<TaskRuntime> {
  return defineAgentRuntimeProvider(AgentTask, {
    id: 'task',
    createApi: () => runtime() as TaskRuntime,
  });
}
