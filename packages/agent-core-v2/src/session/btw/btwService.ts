/**
 * `btw` domain — `ISessionBtwService` implementation.
 *
 * Clones the main agent into a side-question child: inherits profile/context via
 * `IAgentLifecycleService.clone`, then disables tool calls (deny-all permission
 * policy) and appends the side-channel system reminder. Bound at Session scope —
 * `clone('main')` is a session-level operation, so the service injects the
 * session's `IAgentLifecycleService` directly rather than resolving it through
 * the main agent's accessor.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  DenyAllPermissionPolicyService,
  IAgentPermissionPolicyService,
} from '#/agent/permissionPolicy';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';

import { ISessionBtwService, SIDE_QUESTION_SYSTEM_REMINDER, TOOL_CALL_DISABLED_MESSAGE } from './btw';

export class SessionBtwService implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
  ) {}

  async start(): Promise<string> {
    const child = await this.lifecycle.clone('main');
    child.accessor
      .get(IAgentSystemReminderService)
      ?.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER, {
        kind: 'system_trigger',
        name: 'btw',
      });
    child.accessor
      .get(IAgentPermissionPolicyService)
      ?.registerPolicy(new DenyAllPermissionPolicyService(TOOL_CALL_DISABLED_MESSAGE));
    return child.id;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionBtwService,
  SessionBtwService,
  InstantiationType.Delayed,
  'session-btw',
);
