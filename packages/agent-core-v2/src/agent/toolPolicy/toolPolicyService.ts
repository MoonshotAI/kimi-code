import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService, ProfileError, ProfileErrors } from '#/agent/profile/profile';
import { TOOLS_SECTION, type ToolsConfig } from './configSection';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { isMcpToolName, type ToolSource } from '#/tool/toolContract';

import { isToolActive, isToolActiveComposed, type ToolActivationPolicy } from './evaluate';
import { IAgentToolPolicyService } from './toolPolicy';

export class AgentToolPolicyService extends Disposable implements IAgentToolPolicyService {
  declare readonly _serviceBrand: undefined;
  private globalPolicy: ToolsConfig | undefined;

  constructor(
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IConfigService private readonly config: IConfigService,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this.globalPolicy = this.config.get<ToolsConfig | undefined>(TOOLS_SECTION);
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain !== TOOLS_SECTION) return;
        this.globalPolicy = this.config.get<ToolsConfig | undefined>(TOOLS_SECTION);
      }),
    );
    this._register(
      toolExecutor.registerToolCallGuard(({ name, source }) => {
        const active =
          name === SELECT_TOOLS_TOOL_NAME
            ? this.isToolActiveForDisclosure(name, source)
            : this.isToolActive(name, source);
        return active
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

  isToolDenied(name: string, source: ToolSource = isMcpToolName(name) ? 'mcp' : 'builtin'): boolean {
    const deniedBy = (list: readonly string[] | undefined): boolean =>
      list !== undefined && !isToolActive({ disallowedTools: list }, name, source);
    return (
      deniedBy(this.toolPolicyGate.disabledTools) ||
      deniedBy(this.profile.data().disallowedTools) ||
      deniedBy(this.globalPolicy?.disabled) ||
      deniedBy(this.sessionToolPolicy.disabledTools())
    );
  }

  getPolicyFingerprint(): string {
    const profile = this.profile.data();
    return JSON.stringify([
      this.toolPolicyGate.disabledTools,
      profile.activeToolNames,
      profile.disallowedTools,
      this.globalPolicy?.enabled,
      this.globalPolicy?.disabled,
      this.sessionToolPolicy.disabledTools(),
    ].map((names) => names === undefined ? null : [...new Set(names)].toSorted()));
  }

  isToolActiveForDisclosure(name: string, source: ToolSource = 'builtin'): boolean {
    const profile = this.profile.data();
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile: { disallowedTools: profile.disallowedTools },
        global: this.globalPolicy,
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
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
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile,
        global: this.globalPolicy,
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
  ScopeActivation.OnScopeCreated,
  'toolPolicy',
);
