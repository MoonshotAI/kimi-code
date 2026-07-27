import { DynamicInjector } from './injector';

import ENTER_REMINDER from '../workflow/enter-reminder.md?raw';
import EXIT_REMINDER from '../workflow/exit-reminder.md?raw';

export class WorkflowModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'workflow_mode';
  private wasActive = false;

  override onContextClear(): void {
    super.onContextClear();
    this.wasActive = this.agent.workflowMode.isActive;
  }

  override async getInjection(): Promise<string | undefined> {
    const { isActive } = this.agent.workflowMode;

    if (isActive) {
      if (!this.wasActive) {
        this.injectedAt = null;
        this.wasActive = true;
      }
      // Re-inject after compaction when injectedAt was cleared
      if (this.injectedAt === null) {
        return ENTER_REMINDER;
      }
      return undefined;
    }

    if (this.wasActive) {
      this.wasActive = false;
      this.injectedAt = null;
      return EXIT_REMINDER;
    }

    return undefined;
  }
}
