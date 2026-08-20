import type { ReplayableStateKey } from '#/state/state';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { staleGuardKey } from '#/features/staleGuard/staleGuardOps';
import { fullCompactionKey } from '#/agent/fullCompaction/compactionOps';
import { goalKey } from '#/agent/goal/goalOps';
import { goalForkNoticeKey } from '#/agent/goal/goalService';
import { interruptionReminderKey } from '#/agent/interruptionReminder/interruptionReminderOps';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import { turnKey } from '#/agent/loop/turnOps';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
import { pluginSessionStartSnapshotKey } from '#/agent/plugin/agentPluginOps';
import { promptAdmissionKey } from '#/agent/prompt/promptOps';
import { profileActiveToolsKey, profileKey } from '#/agent/profile/profileOps';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import { skillKey } from '#/agent/skill/skillOps';
import { taskKey } from '#/agent/task/taskOps';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { planKey } from '#/features/plan/planOps';
import { swarmKey } from '#/features/swarm/swarmOps';
import { towerKey } from '#/features/tower/towerOps';
import { cronKey } from '#/session/cron/cronOps';
import { interactionKey } from '#/session/interaction/interactionOps';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
  contextMemoryKey,
  staleGuardKey,
  fullCompactionKey,
  goalKey,
  goalForkNoticeKey,
  interruptionReminderKey,
  llmRequestTraceKey,
  turnKey,
  mcpDiscoveryKey,
  permissionModeKey,
  permissionModeConfiguredKey,
  permissionRulesKey,
  pluginSessionStartSnapshotKey,
  promptAdmissionKey,
  profileKey,
  profileActiveToolsKey,
  runtimeBindingKey,
  skillKey,
  taskKey,
  taskNotificationDeliveryKey,
  userToolKey,
  planKey,
  swarmKey,
  towerKey,
  cronKey,
  interactionKey,
];
