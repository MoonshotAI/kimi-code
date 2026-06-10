import type { Agent } from '..';
import type { AgentReplayRecord } from '../..';
import type { ContextMessage } from '../context';

export class ReplayBuilder {
  protected readonly records: AgentReplayRecord[] = [];

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecord): void {
    if (this.agent.records.restoring) {
      this.records.push(record);
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
