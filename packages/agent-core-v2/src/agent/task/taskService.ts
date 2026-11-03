import { event2FromRecord } from '#/app/event/event2';
import type { WireRecord } from '#/wire/record';
import { TERMINAL_STATUSES } from './types';
import { TaskStarted, TaskTerminated } from './taskOps';
import type { AgentTaskInfo, AgentTaskStatus } from './types';

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class AgentTaskService {
  private readonly history = new Map<string, AgentTaskInfo>();

  constructor(private readonly agentId: string) {}

  restore(records: readonly WireRecord[]): void {
    this.history.clear();
    for (const record of records) {
      if (record['agentId'] !== this.agentId) continue;
      const cls = record.type === TaskStarted.type
        ? TaskStarted
        : record.type === TaskTerminated.type
          ? TaskTerminated
          : undefined;
      if (cls === undefined) continue;
      const event = event2FromRecord(cls, record);
      if (!(event instanceof TaskStarted) && !(event instanceof TaskTerminated)) continue;
      const info = event.info.status === 'running' ? { ...event.info, status: 'lost' as const } : event.info;
      this.history.set(info.taskId, info);
    }
  }

  get(taskId: string): AgentTaskInfo | undefined {
    return this.history.get(taskId);
  }

  values(): IterableIterator<AgentTaskInfo> {
    return this.history.values();
  }

  [Symbol.iterator](): IterableIterator<[string, AgentTaskInfo]> {
    return this.history[Symbol.iterator]();
  }

  list(activeOnly: boolean, limit?: number): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    for (const info of this.history.values()) {
      if (!shouldListTask(info, activeOnly)) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }
}

function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}
