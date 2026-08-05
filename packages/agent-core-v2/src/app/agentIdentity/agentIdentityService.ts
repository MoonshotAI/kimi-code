/**
 * `agentIdentity` domain — `IAgentIdentity` implementation.
 *
 * Builds the process-lifetime snapshot from the `[identity]` config section
 * (which already layers `env > config.toml`) and the host's declared display
 * name and request headers in `IBootstrapService.args`, once config has first
 * loaded; later `[identity]` edits take effect on the next start. Bound at
 * App scope, activated eagerly so the freeze is armed before any consumer can
 * observe config readiness — a config load failure still freezes, from
 * whatever the config service then serves, matching what every other section
 * consumer would read.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import {
  buildAgentIdentitySnapshot,
  IAgentIdentity,
  type AgentIdentitySnapshot,
} from './agentIdentity';
import { IDENTITY_SECTION, type IdentityConfig } from './configSection';

export class AgentIdentityService implements IAgentIdentity {
  declare readonly _serviceBrand: undefined;

  private snapshot: AgentIdentitySnapshot | undefined;
  private readonly frozen: Promise<AgentIdentitySnapshot>;

  constructor(
    @IConfigService config: IConfigService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    this.frozen = config.ready
      .catch(() => undefined)
      .then(() => {
        const section = config.get<IdentityConfig | undefined>(IDENTITY_SECTION) ?? {};
        this.snapshot = buildAgentIdentitySnapshot({
          name: section.name,
          slug: section.slug,
          hostDisplayName: bootstrap.args.displayName,
          hostRequestHeaders: bootstrap.args.requestHeaders,
        });
        return this.snapshot;
      });
  }

  resolved(): Promise<AgentIdentitySnapshot> {
    return this.frozen;
  }

  current(): AgentIdentitySnapshot {
    if (this.snapshot === undefined) {
      throw new Error2(
        CoreErrors.codes.INTERNAL,
        'agent identity read before config load completed',
      );
    }
    return this.snapshot;
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentIdentity,
  AgentIdentityService,
  ScopeActivation.OnScopeCreated,
  'agentIdentity',
);
