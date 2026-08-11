// app-core api/daemon/frameClassifier — pure routing of a (possibly
// "event."-prefixed) WS frame into protocol / agent / ignore paths.
//
// Extracted from the consumer agent projector so DaemonEventSocket can classify
// frames without depending on the (i18n / toolMeta-coupled) projector. No
// imports beyond the local frame-name sets.

/**
 * Agent-core event names the projector knows how to project. These are the
 * raw events the real daemon emits. The same names may arrive WITH an "event."
 * prefix (newer daemon) or WITHOUT it (older daemon).
 */
const KNOWN_AGENT_CORE_TYPES = new Set([
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.ended',
  'thinking.delta',
  'assistant.delta',
  'tool.call.started',
  'tool.use', // alias the daemon may use for tool.call.started
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'agent.status.updated',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'session.meta.updated',
  'compaction.started',
  'compaction.completed',
  'compaction.cancelled',
  'goal.updated',
  'error',
  'warning',
  'subagent.spawned',
  'subagent.started',
  'subagent.suspended',
  'subagent.completed',
  'subagent.failed',
  'task.started',
  'task.terminated',
  'background.task.started',
  'background.task.terminated',
  'cron.fired',
]);

/**
 * "event."-prefixed names that are GENUINE protocol events (control/projected
 * events produced server-side). The agent projector must NOT re-handle these —
 * they go through the existing toAppEvent() path.
 */
const PROTOCOL_EVENT_NAMES = new Set([
  // Session lifecycle (projected)
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status_changed',
  'session.usage_updated',
  'session.history_compacted',
  // Message lifecycle (projected)
  'message.created',
  'message.updated',
  // Approval / Question — MUST stay on the protocol path to drive the UI
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'question.requested',
  'question.answered',
  'question.dismissed',
  // Background tasks (projected)
  'task.created',
  'task.progress',
  'task.completed',
  // No-op-but-known protocol streaming / tool events
  'assistant.tool_use_started',
  'assistant.tool_use_delta',
  'assistant.tool_use_completed',
  'assistant.completed',
  'tool.started',
  'tool.output',
  'tool.completed',
]);

const CONTROL_FRAME_TYPES = new Set([
  'server_hello',
  'ack',
  'ping',
  'resync_required',
  'error',
  'pong',
]);

/**
 * Names that are ambiguous between the raw agent-core form (payload.delta is a
 * STRING) and the already-projected protocol form (payload.delta is an object,
 * or the payload carries message_id / content_index).
 */
const AMBIGUOUS_DELTA_NAMES = new Set(['assistant.delta', 'thinking.delta']);

export type FrameRoute =
  | { route: 'protocol' }
  | { route: 'agent'; agentType: string }
  | { route: 'ignore' };

/**
 * Classify a (possibly "event."-prefixed) WS frame into the path it should take.
 *
 * - 'protocol' → hand the original frame to toAppEvent() (existing path).
 * - 'agent'    → hand `agentType` + payload to the agent projector.
 * - 'ignore'   → drop (no session context / unroutable).
 */
export function classifyFrame(rawType: string, payload: unknown): FrameRoute {
  if (CONTROL_FRAME_TYPES.has(rawType)) return { route: 'ignore' };

  const hasPrefix = rawType.startsWith('event.');
  const name = hasPrefix ? rawType.slice('event.'.length) : rawType;

  // Ambiguous delta events: disambiguate by payload shape regardless of prefix.
  if (AMBIGUOUS_DELTA_NAMES.has(name)) {
    if (deltaIsRawAgentCore(payload)) return { route: 'agent', agentType: name };
    // Object delta or protocol-shaped payload → projected protocol event.
    return { route: 'protocol' };
  }

  // Unprefixed frames are raw agent-core (real daemon) when we know the name.
  if (!hasPrefix) {
    if (KNOWN_AGENT_CORE_TYPES.has(name)) return { route: 'agent', agentType: name };
    // Unknown unprefixed name with no protocol meaning → still try the projector
    // (it safely no-ops on unknown types and advances nothing).
    return { route: 'agent', agentType: name };
  }

  // Prefixed frames: genuine protocol events take priority.
  if (PROTOCOL_EVENT_NAMES.has(name)) return { route: 'protocol' };
  // Prefixed agent-core event (e.g. event.turn.started) → strip + project.
  if (KNOWN_AGENT_CORE_TYPES.has(name)) return { route: 'agent', agentType: name };
  // Unknown "event.*" → let toAppEvent() record it as an unknown protocol event.
  return { route: 'protocol' };
}

/**
 * True when an assistant.delta / thinking.delta payload is in the RAW agent-core
 * form: payload.delta is a plain string, and there is no protocol-only field
 * (message_id / content_index). The protocol form uses delta:{text|thinking}.
 */
function deltaIsRawAgentCore(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if ('message_id' in p || 'content_index' in p) return false;
  return typeof p['delta'] === 'string';
}
