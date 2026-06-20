import type { PermissionMode } from '../permission';
import { DynamicInjector } from './injector';

const AUTO_MODE_ENTER_REMINDER = [
  'Auto permission mode is active. Tool approvals will be handled automatically while this mode remains enabled.',
  '  - Continue normally without pausing for approval prompts.',
  '  - Do NOT call AskUserQuestion while auto mode is active unless the currently loaded skill explicitly asks you to clarify with the user.',
].join('\n');

const AUTO_MODE_EXIT_REMINDER = [
  'Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode.',
  '  - Continue normally, but expect approval prompts or denials when a tool requires them.',
].join('\n');

export class PermissionModeInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'permission_mode';
  private lastMode: PermissionMode | undefined;

  getInjection(): string | undefined {
    const mode = this.agent.permission.mode;
    const previousMode = this.lastMode;

    if (mode === previousMode) return undefined;

    this.lastMode = mode;
    if (mode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}
