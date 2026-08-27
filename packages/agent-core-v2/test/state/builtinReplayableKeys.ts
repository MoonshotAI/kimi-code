import type { ReplayableStateKey } from '#/state/state';

import { staleGuardKey } from '#/features/staleGuard/staleGuardOps';
import { interruptionReminderKey } from '#/agent/interruptionReminder/interruptionReminderOps';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import { pluginSessionStartSnapshotKey } from '#/agent/plugin/agentPluginOps';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import { taskKey } from '#/agent/task/taskOps';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { planKey } from '#/features/plan/planOps';
import { swarmKey } from '#/features/swarm/swarmOps';
import { towerKey, towerOwnerKey } from '#/features/tower/towerOps';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
  staleGuardKey,
  interruptionReminderKey,
  mcpDiscoveryKey,
  pluginSessionStartSnapshotKey,
  runtimeBindingKey,
  taskKey,
  taskNotificationDeliveryKey,
  userToolKey,
  planKey,
  swarmKey,
  towerKey,
  towerOwnerKey,
];
