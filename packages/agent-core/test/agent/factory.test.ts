import { describe, expect, it } from 'vitest';

import type { Kaos } from '@moonshot-ai/kaos';

import { AgentFactory } from '../../src/agent/factory';
import type { Agent, AgentOptions, AgentType } from '../../src/agent/index';
import { ICronService } from '../../src/agent/cron';
import { IGoalService } from '../../src/agent/goal';
import { ILifecycleService } from '../../src/agent/lifecycle';
import { IRecordsService } from '../../src/agent/records';
import { IAgentSkillService } from '../../src/agent/skill';
import type { SkillRegistry } from '../../src/agent/skill/types';
import { ITurnService } from '../../src/agent/turn';
import { IDomainEventBus } from '../../src/event/event-bus';
import { noopTelemetryClient } from '../../src/telemetry';

function makeStubAgent(overrides: { type?: AgentType } = {}): Agent {
  return {
    type: overrides.type ?? 'main',
    kaos: {} as Kaos,
    homedir: undefined,
    telemetry: noopTelemetryClient,
  } as unknown as Agent;
}

function makeOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { kaos: {} as Kaos, ...overrides };
}

describe('AgentFactory.buildServiceCollection', () => {
  it('registers the core per-agent services', () => {
    const services = AgentFactory.buildServiceCollection(
      makeStubAgent(),
      makeOptions(),
      undefined,
      undefined,
    );

    expect(services.has(IRecordsService)).toBe(true);
    expect(services.has(ITurnService)).toBe(true);
    expect(services.has(IGoalService)).toBe(true);
    expect(services.has(IDomainEventBus)).toBe(true);
    expect(services.has(ILifecycleService)).toBe(true);
  });

  it('registers IAgentSkillService only when options.skills is provided', () => {
    const withoutSkills = AgentFactory.buildServiceCollection(
      makeStubAgent(),
      makeOptions(),
      undefined,
      undefined,
    );
    expect(withoutSkills.has(IAgentSkillService)).toBe(false);

    const skills = {} as unknown as SkillRegistry;
    const withSkills = AgentFactory.buildServiceCollection(
      makeStubAgent(),
      makeOptions({ skills }),
      undefined,
      undefined,
    );
    expect(withSkills.has(IAgentSkillService)).toBe(true);
  });

  it('registers ICronService for non-sub agents only', () => {
    const mainAgentServices = AgentFactory.buildServiceCollection(
      makeStubAgent({ type: 'main' }),
      makeOptions(),
      undefined,
      undefined,
    );
    expect(mainAgentServices.has(ICronService)).toBe(true);

    const subAgentServices = AgentFactory.buildServiceCollection(
      makeStubAgent({ type: 'sub' }),
      makeOptions(),
      undefined,
      undefined,
    );
    expect(subAgentServices.has(ICronService)).toBe(false);
  });
});
