import type { ReplayableStateKey } from '#/state/state';

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
import { environmentBindingKey } from '#/agent/environmentBinding/environmentBindingOps';
import { taskKey } from '#/agent/task/taskOps';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { fileHistoryKey } from '#/features/fileHistory/fileHistoryOps';
import { planKey } from '#/features/plan/planOps';
import { swarmKey, swarmReminderDeliveredKey } from '#/features/swarm/swarmOps';
import { towerKey, towerOwnerKey } from '#/features/tower/towerOps';

export const BUILTIN_REPLAYABLE_STATE_KEYS: readonly ReplayableStateKey<any>[] = [
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
  environmentBindingKey,
  taskKey,
  toolSelectKey,
  userToolKey,
  fileHistoryKey,
  planKey,
  swarmKey, swarmReminderDeliveredKey,
  towerKey,
  towerOwnerKey,
];
