import type { Kaos } from '@moonshot-ai/kaos';

import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../../profile';
import type { IAgentConfigService } from '../config';
import type { IAgentSkillService } from '../skill';
import type { IAgentToolService } from '../tool';

/**
 * Narrow read-only view of the agent that {@link AgentProfileService} needs in
 * order to apply a resolved profile. `Agent` satisfies this structurally, but
 * the service depends only on this interface — never on the concrete `Agent`
 * class — so tests can drive it with a plain stub.
 *
 * The service reads these fields at `useProfile()` call-time (after the agent
 * has finished constructing), which is why this host can be handed to the
 * service before the underlying services have been resolved, and why no DI
 * cycle is introduced: the service is not injected back into any of the
 * services it coordinates.
 */
export interface AgentProfileHost {
  readonly kaos: Kaos;
  readonly config: IAgentConfigService;
  readonly skills: IAgentSkillService | null;
  readonly tools: IAgentToolService;
}

/**
 * Owns the agent's `useProfile()` behavior: render the profile's system prompt
 * against the live runtime context, push `{ profileName, systemPrompt }` into
 * config, and activate the profile's tool set.
 */
export interface IAgentProfileService {
  /**
   * Applies a resolved profile to the agent. Mirrors the former
   * `Agent.useProfile` signature exactly.
   */
  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void;
}

export class AgentProfileService implements IAgentProfileService {
  constructor(private readonly host: AgentProfileHost) {}

  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.host.kaos.osEnv,
      cwd: this.host.config.cwd,
      skills: this.host.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
    });
    this.host.config.update({ profileName: profile.name, systemPrompt });
    this.host.tools.setActiveTools(profile.tools);
  }
}
