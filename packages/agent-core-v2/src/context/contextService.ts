/**
 * `context` domain (L4) — `IContextService` implementation.
 *
 * Owns the agent's conversation history, projection, compaction, and undo;
 * records context through `records`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentRecords } from '#/records/records';

import { type ContextMessage, IContextService } from './context';

function estimateTokens(messages: readonly ContextMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

export class ContextService implements IContextService {
  declare readonly _serviceBrand: undefined;
  private history: ContextMessage[] = [];
  private snapshot: ContextMessage[] | undefined;

  constructor(@IAgentRecords _records: IAgentRecords) {}

  appendMessage(msg: ContextMessage): void {
    this.history.push(msg);
  }

  appendSystemReminder(text: string): void {
    this.history.push({ role: 'system', content: text });
  }

  project(): readonly ContextMessage[] {
    return this.history;
  }

  applyCompaction(summary: string): void {
    this.snapshot = this.history;
    this.history = [{ role: 'system', content: summary }];
  }

  undo(): void {
    if (this.snapshot !== undefined) {
      this.history = this.snapshot;
      this.snapshot = undefined;
      return;
    }
    this.history.pop();
  }

  tokenUsage(): number {
    return estimateTokens(this.history);
  }
}

registerScopedService(LifecycleScope.Agent, IContextService, ContextService, InstantiationType.Delayed, 'context');
