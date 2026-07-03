import type { PermissionMode } from '../permission';
import { DynamicInjector } from './injector';

const AUTO_MODE_ENTER_REMINDER = [
  'Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.',
  '  - Continue normally without pausing for approval prompts.',
  '  - Do NOT call AskUserQuestion while auto mode is active. Make a reasonable decision and continue without asking the user.',
].join('\n');

const AUTO_MODE_EXIT_REMINDER = [
  'Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.',
  '  - Continue normally, but expect approval prompts or denials when a tool requires them.',
].join('\n');

export class PermissionModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'permission_mode';
  private lastMode: PermissionMode | undefined;
  private refreshAfterCompaction = false;

  override onContextCompacted(): void {
    this.injectedAt = null;
    this.refreshAfterCompaction = true;
  }

  getInjection(): string | undefined {
    const mode = this.agent.permission.mode;
    const previousMode = this.lastMode;

    if (!this.refreshAfterCompaction && mode === previousMode) return undefined;

    this.refreshAfterCompaction = false;
    this.lastMode = mode;
    if (mode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}
