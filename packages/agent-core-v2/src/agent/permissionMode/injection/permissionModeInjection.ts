/**
 * `permissionMode` domain (L3) — permission-mode context injection.
 *
 * Owns the `permission_mode` context-injection provider. It reads the live mode
 * from `IAgentPermissionModeService` and registers reminders through
 * `contextInjector`. Dedup is history-derived: the framework mirrors this
 * variant's live positions across splices, so a reminder folded away by
 * compaction (or undo) is re-announced on the next inject, while one surviving
 * in restored history is adopted silently instead of duplicated.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export class PermissionModeInjection extends Disposable {
  private lastMode: PermissionMode | undefined;

  constructor(
    private readonly permissionMode: Pick<IAgentPermissionModeService, 'mode'>,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      dynamicInjector.register(PERMISSION_MODE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private reminder({ injectedPositions }: ContextInjectionContext): string | undefined {
    const currentMode = this.permissionMode.mode;
    const previousMode = this.lastMode;
    if (currentMode === previousMode) {
      // Same mode as last announced: re-announce only when the live reminder
      // was spliced out (compaction / undo) and the current mode carries one.
      if (injectedPositions.length > 0 || currentMode !== 'auto') return undefined;
      return AUTO_MODE_ENTER_REMINDER;
    }
    // Fresh instance: a live reminder from restored history already covers the
    // current mode — adopt it silently instead of duplicating the announcement.
    if (previousMode === undefined && injectedPositions.length > 0) {
      this.lastMode = currentMode;
      return undefined;
    }
    this.lastMode = currentMode;
    if (currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}
