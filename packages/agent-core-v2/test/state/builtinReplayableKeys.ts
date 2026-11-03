import type { ReplayableStateKey } from '#/state/state';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { fullCompactionKey, fullCompactionWireRangesKey } from '#/agent/fullCompaction/compactionOps';
import { interruptionReminderKey } from '#/agent/interruptionReminder/interruptionReminderOps';
import { llmRequestTraceKey } from '#/agent/loop/llmRequestOps';
import { turnKey } from '#/agent/loop/turnOps';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import { mcpFailureKey } from '#/agent/mcp/mcpFailureOps';
import {
  permissionModeConfiguredKey,
  permissionModeKey,
} from '#/agent/permissionMode/permissionModeOps';
import { permissionRulesKey } from '#/agent/permissionRules/permissionRulesOps';
import { pluginSessionStartSnapshotKey } from '#/agent/plugin/agentPluginOps';
import { changeNotifierSnapshotKey } from '#/agent/changeNotifier/changeNotifierOps';
import { profileActiveToolsKey, profileKey } from '#/agent/profile/profileOps';
import { environmentBindingKey } from '#/agent/environmentBinding/environmentBindingOps';
import { taskKey } from '#/agent/task/taskOps';
import { taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { fileHistoryKey } from '#/features/fileHistory/fileHistoryOps';
import { planKey } from '#/features/plan/planOps';
import { swarmKey } from '#/features/swarm/swarmOps';
import { towerKey, towerOwnerKey } from '#/features/tower/towerOps';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
  contextMemoryKey,
  fullCompactionKey,
  fullCompactionWireRangesKey,
  interruptionReminderKey,
  llmRequestTraceKey,
  turnKey,
  mcpDiscoveryKey,
  mcpFailureKey,
  permissionModeKey,
  permissionModeConfiguredKey,
  permissionRulesKey,
  pluginSessionStartSnapshotKey,
  changeNotifierSnapshotKey,
  profileKey,
  profileActiveToolsKey,
  environmentBindingKey,
  taskKey,
  taskNotificationDeliveryKey,
  toolSelectKey,
  userToolKey,
  fileHistoryKey,
  planKey,
  swarmKey,
  towerKey,
  towerOwnerKey,
];
