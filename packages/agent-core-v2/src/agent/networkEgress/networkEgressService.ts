

import { matchesHostPattern } from '@moonshot-ai/exec-policy';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentExecPolicyService } from '#/agent/execPolicy/execPolicy';
import {
  INetworkProxyService,
  type EgressDecision,
} from '#/os/sandbox/networkProxy';
import { resolveSandboxConfig } from '#/os/sandbox/configSection';
import {
  INetworkEgressPolicy,
  type SandboxProxyEnvironment,
} from './networkEgress';
import { NETWORK_EGRESS_FLAG_ID } from './flag';

export class AgentNetworkEgressPolicyService implements INetworkEgressPolicy {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAgentExecPolicyService private readonly execPolicy: IAgentExecPolicyService,
    @INetworkProxyService private readonly proxy: INetworkProxyService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {}

  async decide(
    host: string,
    protocol?: 'http' | 'connect' | 'socks5',
  ): Promise<EgressDecision> {
    const network = resolveSandboxConfig(this.config)?.network;
    const mode = network?.mode ?? 'all';
    if (mode === 'off') return 'deny';
    if ((network?.deniedDomains ?? []).some((d) => matchesHostPattern(d, host))) {
      return 'deny';
    }
    const ruleDecision = await this.execPolicy.evaluateHost(host, protocol);
    if (ruleDecision.decision === 'forbidden') return 'deny';
    if (ruleDecision.decision === 'allow') return 'allow';
    if ((network?.allowedDomains ?? []).some((d) => matchesHostPattern(d, host))) {
      return 'allow';
    }
    return mode === 'all' ? 'allow' : 'deny';
  }

  async acquireProxyEnvironment(): Promise<SandboxProxyEnvironment | undefined> {
    if (!this.flags.enabled(NETWORK_EGRESS_FLAG_ID)) return undefined;
    const mode = resolveSandboxConfig(this.config)?.network?.mode ?? 'all';
    if (mode !== 'allowlist') return undefined;
    const registration = await this.proxy.acquire((host, protocol) =>
      this.decide(host, protocol),
    );
    if (registration === undefined) {
      this.log.warn('network egress proxy unavailable; sandboxed network stays closed');
      return undefined;
    }
    return {
      env: registration.env,
      httpPort: registration.httpPort,
      socksPort: registration.socksPort,
      token: registration.token,
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  INetworkEgressPolicy,
  AgentNetworkEgressPolicyService,
  ScopeActivation.OnScopeCreated,
  'networkEgress',
);
