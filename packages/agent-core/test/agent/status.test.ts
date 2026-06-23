import { UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { AgentStatusService, type AgentStatusHost } from '../../src/agent/status';
import type { IAgentConfigService } from '../../src/agent/config';
import type { IContextService } from '../../src/agent/context';
import type { IDomainEventBus } from '#/event';
import type { IPermissionService, PermissionMode } from '../../src/agent/permission';
import type { IPlanService } from '../../src/agent/plan';
import type { IRecordsService } from '../../src/agent/records';
import type { ISwarmService } from '../../src/agent/swarm';
import type { IUsageService } from '../../src/agent/usage';
import type { AgentEvent, UsageStatus } from '../../src/rpc';

interface HostOverrides {
  readonly restoring?: boolean;
  readonly hasModel?: boolean;
  readonly model?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number | undefined;
  readonly usage?: UsageStatus | undefined;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
}

function makeHost(overrides: HostOverrides = {}): {
  host: AgentStatusHost;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  const modelCapabilities = {
    ...UNKNOWN_CAPABILITY,
    max_context_tokens: overrides.maxContextTokens,
  };
  const restoring = overrides.restoring ?? false;
  const host: AgentStatusHost = {
    records: { restoring: restoring ? { time: 0 } : null } as unknown as IRecordsService,
    config: {
      hasModel: overrides.hasModel ?? true,
      model: overrides.model ?? 'test-model',
      modelCapabilities,
    } as unknown as IAgentConfigService,
    context: {
      tokenCount: overrides.contextTokens ?? 0,
    } as unknown as IContextService,
    usage: {
      status: () => overrides.usage,
    } as unknown as IUsageService,
    planMode: { isActive: overrides.planMode ?? false } as unknown as IPlanService,
    swarmMode: { isActive: overrides.swarmMode ?? false } as unknown as ISwarmService,
    permission: { mode: overrides.permission ?? 'manual' } as unknown as IPermissionService,
    eventBus: {
      publish: (event: AgentEvent) => {
        events.push(event);
      },
    } as unknown as IDomainEventBus,
  };
  return { host, events };
}

describe('AgentStatusService', () => {
  it('publishes agent.status.updated with the expected payload', () => {
    const { host, events } = makeHost({
      model: 'kimi-k2',
      contextTokens: 250,
      maxContextTokens: 1000,
      planMode: true,
      swarmMode: false,
      permission: 'yolo',
    });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('agent.status.updated');
    if (event?.type !== 'agent.status.updated') throw new Error('unexpected event type');
    expect(event.model).toBe('kimi-k2');
    expect(event.contextTokens).toBe(250);
    expect(event.maxContextTokens).toBe(1000);
    expect(event.planMode).toBe(true);
    expect(event.swarmMode).toBe(false);
    expect(event.permission).toBe('yolo');
  });

  it('computes contextUsage as contextTokens / maxContextTokens', () => {
    const { host, events } = makeHost({ contextTokens: 250, maxContextTokens: 1000 });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    const event = events[0];
    if (event?.type !== 'agent.status.updated') throw new Error('unexpected event type');
    expect(event.contextUsage).toBeCloseTo(0.25);
  });

  it('forwards the usage snapshot from the usage service', () => {
    const usage: UsageStatus = {
      total: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    } as unknown as UsageStatus;
    const { host, events } = makeHost({ usage });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    const event = events[0];
    if (event?.type !== 'agent.status.updated') throw new Error('unexpected event type');
    expect(event.usage).toEqual(usage);
  });

  it('does not emit while records are restoring', () => {
    const { host, events } = makeHost({ restoring: true });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    expect(events).toHaveLength(0);
  });

  it('does not emit when no model is configured', () => {
    const { host, events } = makeHost({ hasModel: false });
    const service = new AgentStatusService(host);

    service.notifyStatusChanged();

    expect(events).toHaveLength(0);
  });
});
