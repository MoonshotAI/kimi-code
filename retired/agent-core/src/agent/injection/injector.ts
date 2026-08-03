import type { Agent } from '..';

export abstract class DynamicInjector {
  protected injectedAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
  }

  onContextCompacted(): void {
    this.injectedAt = null;
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
