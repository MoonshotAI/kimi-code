import agentMessage from "./session-update-agent-message.json";
import agentThought from "./session-update-agent-thought.json";
import availableCommands from "./session-update-available-commands.json";
import compactionCompleted from "./kimi-compaction-completed.json";
import compactionStarted from "./kimi-compaction-started.json";
import configOption from "./session-update-config-option.json";
import permissionNumericId from "./session-request-permission-numeric-id.json";
import plan from "./session-update-plan.json";
import stepInterrupted from "./kimi-step-interrupted.json";
import subagentChildToolCall from "./kimi-subagent-child-tool-call.json";
import subagentStarted from "./kimi-subagent-started.json";
import toolCallLifecycle from "./session-update-tool-call-lifecycle.json";
import unknownSessionUpdate from "./session-update-unknown.json";
import usageUpdate from "./session-update-usage.json";
import userMessage from "./session-update-user-message.json";

export const acpLegacyFixtures = [
  userMessage,
  agentMessage,
  agentThought,
  plan,
  configOption,
  availableCommands,
  usageUpdate,
  toolCallLifecycle,
  unknownSessionUpdate,
  stepInterrupted,
  compactionStarted,
  compactionCompleted,
  subagentStarted,
  subagentChildToolCall,
  permissionNumericId,
] as const;

export {
  agentMessage,
  agentThought,
  availableCommands,
  compactionCompleted,
  compactionStarted,
  configOption,
  permissionNumericId,
  plan,
  stepInterrupted,
  subagentChildToolCall,
  subagentStarted,
  toolCallLifecycle,
  unknownSessionUpdate,
  usageUpdate,
  userMessage,
};
