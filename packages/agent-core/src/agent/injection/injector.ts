import type { Agent } from '..';

export abstract class DynamicInjector {
  protected injectedAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
  }

  onContextCompacted(compactedCount: number): void {
    if (this.injectedAt !== null) {
      // applyCompaction replaces the first `compactedCount` messages with a
      // single summary at index 0, so a surviving injection (old index >=
      // compactedCount) maps to new index >= 1. An injection that was inside
      // the compacted prefix — including the last one (injectedAt ===
      // compactedCount - 1, which yields 0) — was folded into the summary and
      // must become null rather than pointing at the summary itself.
      const newInjectedAt = this.injectedAt - compactedCount + 1;
      this.injectedAt = newInjectedAt >= 1 ? newInjectedAt : null;
    }
  }

  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) {
      this.injectedAt--;
    } else if (index === this.injectedAt) {
      this.injectedAt = null;
    }
  }

  async inject(): Promise<void> {
    const injection = await this.getInjection();
    if (injection) {
      this.injectedAt = this.agent.context.history.length;
      this.agent.context.appendSystemReminder(injection, {
        kind: 'injection',
        variant: this.injectionVariant,
      });
    }
  }

  protected abstract readonly injectionVariant: string;

  protected abstract getInjection(): string | Promise<string | undefined> | undefined;
}
