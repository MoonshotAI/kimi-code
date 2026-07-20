/**
 * `toolPolicy` domain (L4) — Agent-scope tool authorization service.
 *
 * Intersects the bound profile policy, global `[tools]` configuration, and
 * Session denylist (composed by `isToolActiveComposed` in `./evaluate`), and
 * installs the resulting authorization check into the L3 executor preflight so
 * direct tool calls cannot bypass schema filtering. `select_tools` is exempt
 * from the preflight gate: it is the progressive-disclosure loading entry
 * point whose loadable set is itself policy-filtered, so rejecting the call
 * would only contradict the schema layer that advertises it.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService, ProfileError, ProfileErrors } from '#/agent/profile/profile';
import {
  TOOLS_SECTION,
  type ToolsConfig,
} from '#/agent/profile/configSection';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import type { ToolSource } from '#/tool/toolContract';

import { isToolActiveComposed, type ToolActivationPolicy } from './evaluate';
import { IAgentToolPolicyService } from './toolPolicy';

export class AgentToolPolicyService extends Disposable implements IAgentToolPolicyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(
      toolExecutor.registerToolCallGuard(({ name, source }) => {
        // The disclosure loading entry point: the schema layer advertises it
        // only while disclosure is on, its execute() self-rejects when it is
        // off, and the set it can load is policy-filtered — a policy rejection
        // here would just contradict the schema layer (see `toolSelect`).
        if (name === SELECT_TOOLS_TOOL_NAME) return undefined;
        return this.isToolActive(name, source)
          ? undefined
          : `Tool "${name}" is disabled by the active tool policy`;
      }),
    );
  }

  isToolActive(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profile.data();
    return this.isToolActiveForProfile(
      {
        tools: profile.activeToolNames,
        disallowedTools: profile.disallowedTools,
      },
      name,
      source,
    );
  }

  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    return isToolActiveComposed(
      {
        profile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
    );
  }

  async setSessionDisabledTools(names: readonly string[]): Promise<void> {
    if (this.profile.data().profileName === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_NOT_BOUND,
        'Cannot set session disabled tools: agent profile is not bound',
      );
    }
    await this.sessionToolPolicy.setDisabledTools(names);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolPolicyService,
  AgentToolPolicyService,
  InstantiationType.Eager,
  'toolPolicy',
);
