import type { ReplayableStateKey } from '#/state/state';

import { staleGuardKey } from '#/features/staleGuard/staleGuardOps';
import { fullCompactionKey } from '#/agent/fullCompaction/compactionOps';
import { interruptionReminderKey } from '#/agent/interruptionReminder/interruptionReminderOps';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import { turnKey } from '#/agent/loop/turnOps';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import { pluginSessionStartSnapshotKey } from '#/agent/plugin/agentPluginOps';
import { promptAdmissionKey } from '#/agent/prompt/promptOps';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import { taskKey } from '#/agent/task/taskOps';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { planKey } from '#/features/plan/planOps';
import { swarmKey } from '#/features/swarm/swarmOps';
import { towerKey, towerOwnerKey } from '#/features/tower/towerOps';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
  staleGuardKey,
  fullCompactionKey,
  interruptionReminderKey,
  llmRequestTraceKey,
  turnKey,
  mcpDiscoveryKey,
  pluginSessionStartSnapshotKey,
  promptAdmissionKey,
  runtimeBindingKey,
  taskKey,
  taskNotificationDeliveryKey,
  userToolKey,
  planKey,
  swarmKey,
  towerKey,
  towerOwnerKey,
];
