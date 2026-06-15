import type { Agent } from '..';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../..';
import type { ContextMessage } from '../context';

export class ReplayBuilder {
  postRestoring = false;
  captureLiveRecords = false;
  protected readonly records: AgentReplayRecord[] = [];

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecordPayload): void {
    if (this.captureLiveRecords || this.agent.records.restoring || this.postRestoring) {
      this.records.push({
        ...record,
        time: this.agent.records.restoring?.time ?? Date.now(),
      });
    }
  }

  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void {
    if (this.agent.records.restoring) {
      const last = this.records.at(-1);
      if (last && last.type === type) {
        Object.assign(last, patch);
      }
    }
  }

  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (removedMessages.size === 0) return;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]!;
      if (record.type === 'message' && removedMessages.has(record.message)) {
        this.records.splice(i, 1);
      }
    }
  }

  buildResult(): readonly AgentReplayRecord[] {
    return this.records;
  }
}
