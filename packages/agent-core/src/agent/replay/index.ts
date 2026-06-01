import type { Agent } from '..';
import type { AgentReplayRecord } from '../..';

export class ReplayBuilder {
  protected readonly records: AgentReplayRecord[] = [];

  constructor(public readonly agent: Agent) {}

  push(record: AgentReplayRecord): void {
    if (this.agent.records.restoring) {
      this.records.push(record);
    }
  }

  removeLastMessages(count: number): void {
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0 && removed < count; i--) {
      if (this.records[i]!.type === 'message') {
        this.records.splice(i, 1);
        removed++;
      }
    }
  }

  buildResult(): readonly AgentReplayRecord[] {
    return this.records;
  }
}
