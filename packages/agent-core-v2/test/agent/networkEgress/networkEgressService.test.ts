import { describe, expect, it } from 'vitest';

import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import type { IConfigService } from '#/app/config/config';
import type { IAgentExecPolicyService } from '#/agent/execPolicy/execPolicy';
import { NETWORK_EGRESS_FLAG_ID } from '#/agent/networkEgress/flag';
import { AgentNetworkEgressPolicyService } from '#/agent/networkEgress/networkEgressService';
import type { INetworkProxyService } from '#/os/sandbox/networkProxy';
import { SANDBOX_SECTION } from '#/os/sandbox/configSection';

function stubConfig(values: Record<string, unknown>): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

function stubExecPolicy(decision: 'allow' | 'prompt' | 'forbidden' | 'none' = 'none') {
  return {
    _serviceBrand: undefined,
    evaluate: async () => ({ verdict: 'none', segments: [], segmentCount: 0 }),
    evaluateHost: async () => ({ decision }),
    addSessionRule: () => {},
  } as unknown as IAgentExecPolicyService;
}

function stubProxy(available = true): INetworkProxyService & {
  acquiredDecider?: (host: string, protocol: 'http' | 'connect' | 'socks5') => Promise<Egress>;
} {
  const stub: INetworkProxyService & {
    acquiredDecider?: (host: string, protocol: 'http' | 'connect' | 'socks5') => unknown;
  } = {
    _serviceBrand: undefined,
    acquire: async (decide) => {
      stub.acquiredDecider = decide;
      return available
        ? {
            token: 'tok',
            httpPort: 8080,
            socksPort: 8081,
            env: { HTTP_PROXY: 'http://tok:x@127.0.0.1:8080' },
            dispose: () => {},
          }
        : undefined;
    },
    release: () => {},
  };
  return stub as never;
}

type Egress = 'allow' | 'deny';

function service(options: {
  network?: Record<string, unknown>;
  ruleDecision?: 'allow' | 'prompt' | 'forbidden' | 'none';
  flagEnabled?: boolean;
  proxy?: INetworkProxyService;
}) {
  const config = stubConfig(
    options.network === undefined ? {} : { [SANDBOX_SECTION]: { network: options.network } },
  );
  return new AgentNetworkEgressPolicyService(
    config,
    stubExecPolicy(options.ruleDecision),
    options.proxy ?? stubProxy(),
    stubFlag(options.flagEnabled ?? true),
    stubLog(),
  );
}

describe('AgentNetworkEgressPolicyService.decide', () => {
  it('denies everything when network mode is off', async () => {
    const svc = service({ network: { mode: 'off' }, ruleDecision: 'allow' });
    await expect(svc.decide('example.com')).resolves.toBe('deny');
  });

  it('denies denied_domains even when a rule allows', async () => {
    const svc = service({
      network: { mode: 'allowlist', deniedDomains: ['*.example.com'], allowedDomains: ['a.example.com'] },
      ruleDecision: 'allow',
    });
    await expect(svc.decide('a.example.com')).resolves.toBe('deny');
  });

  it('denies on a forbidden network_rule', async () => {
    const svc = service({ network: { mode: 'allowlist' }, ruleDecision: 'forbidden' });
    await expect(svc.decide('example.com')).resolves.toBe('deny');
  });

  it('denies prompt rules at the wire (approval happens at command level)', async () => {
    const svc = service({ network: { mode: 'allowlist' }, ruleDecision: 'prompt' });
    await expect(svc.decide('example.com')).resolves.toBe('deny');
  });

  it('allows allowed_domains and *. wildcards including the apex', async () => {
    const svc = service({
      network: { mode: 'allowlist', allowedDomains: ['*.example.com'] },
      ruleDecision: 'none',
    });
    await expect(svc.decide('a.example.com')).resolves.toBe('allow');
    await expect(svc.decide('example.com')).resolves.toBe('allow');
    await expect(svc.decide('other.com')).resolves.toBe('deny');
  });

  it('allows a matching allow network_rule under allowlist mode', async () => {
    const svc = service({ network: { mode: 'allowlist' }, ruleDecision: 'allow' });
    await expect(svc.decide('registry.example.com')).resolves.toBe('allow');
  });

  it('allows everything in mode all', async () => {
    const svc = service({ network: { mode: 'all' }, ruleDecision: 'none' });
    await expect(svc.decide('anything.example.com')).resolves.toBe('allow');
  });
});

describe('AgentNetworkEgressPolicyService.acquireProxyEnvironment', () => {
  it('returns undefined when the flag is off', async () => {
    const svc = service({ network: { mode: 'allowlist' }, flagEnabled: false });
    await expect(svc.acquireProxyEnvironment()).resolves.toBeUndefined();
  });

  it('returns undefined when mode is not allowlist', async () => {
    const svc = service({ network: { mode: 'all' } });
    await expect(svc.acquireProxyEnvironment()).resolves.toBeUndefined();
    const off = service({ network: { mode: 'off' } });
    await expect(off.acquireProxyEnvironment()).resolves.toBeUndefined();
  });

  it('returns env + ports + token when allowlist is configured', async () => {
    const proxy = stubProxy();
    const svc = service({ network: { mode: 'allowlist' }, proxy });
    const env = await svc.acquireProxyEnvironment();
    expect(env).toBeDefined();
    expect(env!.httpPort).toBe(8080);
    expect(env!.socksPort).toBe(8081);
    expect(env!.env['HTTP_PROXY']).toContain('tok:x@');
    expect(proxy.acquiredDecider).toBeDefined();
  });

  it('the registered decider routes through decide()', async () => {
    const proxy = stubProxy();
    const svc = service({
      network: { mode: 'allowlist', allowedDomains: ['ok.example.com'] },
      proxy,
    });
    await svc.acquireProxyEnvironment();
    await expect(proxy.acquiredDecider!('ok.example.com', 'connect')).resolves.toBe('allow');
    await expect(proxy.acquiredDecider!('nope.example.com', 'connect')).resolves.toBe('deny');
  });

  it('returns undefined when the proxy cannot start', async () => {
    const svc = service({ network: { mode: 'allowlist' }, proxy: stubProxy(false) });
    await expect(svc.acquireProxyEnvironment()).resolves.toBeUndefined();
  });
});
