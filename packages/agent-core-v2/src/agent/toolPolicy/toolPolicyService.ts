/**
 * `toolPolicy` domain (L4) — Agent-scope tool authorization service.
 *
 * Intersects the bound profile policy, global `[tools]` configuration, and
 * Session denylist, and installs the resulting authorization check into the
 * L3 executor preflight so direct tool calls cannot bypass schema filtering.
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
import type { ToolSource } from '#/tool/toolContract';

import { isToolActive as evaluateToolActive } from './evaluate';
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
      toolExecutor.registerToolCallGuard(({ name, source }) =>
        this.isToolActive(name, source)
          ? undefined
          : `Tool "${name}" is disabled by the active tool policy`,
      ),
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
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    const globalTools = this.config.get<ToolsConfig>(TOOLS_SECTION);
    return (
      evaluateToolActive(
        profile,
        name,
        source,
      ) &&
      evaluateToolActive(
        {
          tools: globalTools?.enabled?.length ? globalTools.enabled : undefined,
          disallowedTools: globalTools?.disabled,
        },
        name,
        source,
      ) &&
      evaluateToolActive(
        { disallowedTools: this.sessionToolPolicy.disabledTools() },
        name,
        source,
      )
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
