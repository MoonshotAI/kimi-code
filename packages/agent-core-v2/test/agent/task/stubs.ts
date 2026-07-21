/**
 * Scenario: shared Agent task test wiring and per-agent persistence addressing.
 *
 * Exposes the test manager contract and builds persistence beneath the main
 * agent scope so fixtures cannot accidentally seed session-wide task records.
 */

import { join } from 'pathe';

import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  type IAgentTaskService,
} from '#/agent/task/task';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { WriteAuthorityRegistryService } from '#/persistence/backends/node-fs/writeAuthorityRegistryService';
import type { IWriteAuthorityRegistry } from '#/persistence/interface/writeAuthority';

export type TaskServiceTestManager = IAgentTaskService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly AgentTaskInfo[]>;
};

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

/**
 * A real write-authority registry pre-registered with a lenient authority for
 * the test session, so persistence writes pass the fencing check without a
 * kernel lease.
 */
export function stubWriteAuthorityRegistry(sessionId = 'test-session'): IWriteAuthorityRegistry {
  const registry = new WriteAuthorityRegistryService();
  registry.register({
    sessionId,
    assertWritable: () => {},
  });
  return registry;
}

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    new JsonAtomicDocumentStore(storage),
    storage,
    undefined,
    stubWriteAuthorityRegistry(),
  );
}
