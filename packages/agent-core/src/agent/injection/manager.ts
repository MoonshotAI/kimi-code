import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { PermissionModeInjector } from './permission-mode';
import { PlanModeInjector } from './plan-mode';
import { PluginsBootstrapInjector } from './plugins-bootstrap';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginsBootstrapInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
    ];
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  onContextClear(): void {
    for (const injector of this.injectors) {
      injector.onContextClear();
    }
  }

  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        continue;
      }
    }
  }
}
