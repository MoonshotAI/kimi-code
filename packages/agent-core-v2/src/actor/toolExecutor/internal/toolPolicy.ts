import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import { AgentProfile } from '#/actor/profile/profileAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import {
  isToolActiveComposed,
  type ToolActivationPolicy,
} from '#/agent/toolPolicy/evaluate';
import type { ToolSource } from '#/tool/toolContract';
import { ProfileError, ProfileErrors } from '#/actor/profile/errors';

export class AgentToolsPolicy {
  constructor(private readonly runtime: AgentRuntimeContext<unknown>) {}

  isActive(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profile();
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.runtime.get(ISessionToolPolicyGate).disabledTools,
        profile: {
          tools: profile.activeToolNames,
          disallowedTools: profile.disallowedTools,
        },
        global: this.runtime.get(IConfigService).get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.runtime.get(ISessionToolPolicy).disabledTools(),
      },
      name,
      source,
    );
  }

  isActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.runtime.get(ISessionToolPolicyGate).disabledTools,
        profile,
        global: this.runtime.get(IConfigService).get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.runtime.get(ISessionToolPolicy).disabledTools(),
      },
      name,
      source,
    );
  }

  async setSessionDisabledTools(names: readonly string[]): Promise<void> {
    if (this.profile().profileName === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_NOT_BOUND,
        'Cannot set session disabled tools: agent profile is not bound',
      );
    }
    await this.runtime.get(ISessionToolPolicy).setDisabledTools(names);
  }

  isActiveForDisclosure(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profile();
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.runtime.get(ISessionToolPolicyGate).disabledTools,
        profile: { disallowedTools: profile.disallowedTools },
        global: this.runtime.get(IConfigService).get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.runtime.get(ISessionToolPolicy).disabledTools(),
      },
      name,
      source,
    );
  }

  private profile() {
    return this.runtime
      .get(IAgentLifecycleService)
      .resolve(this.runtime.agent, AgentProfile)
      .data();
  }
}
