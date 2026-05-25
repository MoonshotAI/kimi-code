import type { Agent } from '..';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  type AgentRecord,
  type AgentRecordPersistence,
} from './types';

export * from './types';
export {
  FileSystemAgentRecordPersistence,
  InMemoryAgentRecordPersistence,
} from './persistence';
export type { FileSystemAgentRecordPersistenceOptions } from './persistence';

// Contract: restore MUST NOT emit UI events, call the LLM, execute tools, or
// touch the filesystem in a way that triggers external side effects. Each case
// should reproduce the in-memory state the live handler left behind, nothing more.
export function restoreAgentRecord(agent: Agent, input: AgentRecord): void {
  switch (input.type) {
    case 'metadata':
      return;
    case 'turn.prompt':
      agent.turn.restorePrompt();
      return;
    case 'turn.steer':
      agent.turn.restoreSteer(input.input, input.origin);
      return;
    case 'turn.cancel':
      agent.turn.cancel(input.turnId);
      return;
    case 'background.stop':
      return;
    case 'config.update':
      agent.config.update(input);
      return;
    case 'permission.set_mode':
      agent.permission.setMode(input.mode);
      return;
    case 'permission.record_approval_result':
      agent.permission.recordApprovalResult(input);
      return;
    case 'usage.record':
      agent.usage.record(input.model, input.usage, 'session');
      return;
    case 'full_compaction.begin':
      agent.fullCompaction.begin(input);
      return;
    case 'full_compaction.cancel':
      agent.fullCompaction.cancel();
      return;
    case 'full_compaction.complete':
      agent.fullCompaction.complete(input);
      return;
    case 'plan_mode.enter':
      agent.planMode.restoreEnter(input);
      return;
    case 'plan_mode.cancel':
      agent.planMode.cancel(input.id);
      return;
    case 'plan_mode.exit':
      agent.planMode.exit(input.id);
      return;
    case 'context.append_message':
      agent.context.appendMessage(input.message);
      return;
    case 'context.mark_last_user_prompt_blocked':
      agent.context.markLastUserPromptBlocked(input.hookEvent);
      return;
    case 'context.append_loop_event':
      agent.context.appendLoopEvent(input.event);
      return;
    case 'context.clear':
      agent.context.clear();
      return;
    case 'context.apply_compaction':
      agent.context.applyCompaction(input);
      return;
    case 'tools.register_user_tool':
      agent.tools.registerUserTool(input);
      return;
    case 'tools.unregister_user_tool':
      agent.tools.unregisterUserTool(input.name);
      return;
    case 'tools.set_active_tools':
      agent.tools.setActiveTools(input.names);
      return;
    case 'tools.update_store':
      agent.tools.updateStore(input.key, input.value);
      return;
  }
}

export class AgentRecords {
  private _restoring = false;
  private metadataInitialized = false;
  onRecord?: (record: AgentRecord) => void;

  constructor(
    private readonly restoreRecord: (record: AgentRecord) => void,
    private readonly persistence?: AgentRecordPersistence,
  ) {}

  get restoring() {
    return this._restoring;
  }

  logRecord(record: AgentRecord): void {
    if (this._restoring) return;
    const stamped: AgentRecord =
      record.time !== undefined ? record : { ...record, time: Date.now() };
    if (
      this.persistence !== undefined &&
      !this.metadataInitialized &&
      stamped.type !== 'metadata'
    ) {
      this.persistence.append({
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      });
      this.metadataInitialized = true;
    }
    if (stamped.type === 'metadata') {
      this.metadataInitialized = true;
    }
    this.persistence?.append(stamped);
    this.onRecord?.(stamped);
  }

  restore(record: AgentRecord): void {
    this._restoring = true;
    try {
      this.restoreRecord(record);
    } finally {
      this._restoring = false;
    }
  }

  async replay(): Promise<void> {
    if (!this.persistence) throw new Error('No persistence provided for AgentRecords');
    for await (const record of this.persistence.read()) {
      if (!this.metadataInitialized) {
        this.metadataInitialized = true;
      }
      this.restore(record);
    }
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }
}
