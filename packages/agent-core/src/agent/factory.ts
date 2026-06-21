import type { AgentEvent } from '#/rpc';

import { ServiceCollection, SyncDescriptor } from '../di';
import { DomainEventBus, IDomainEventBus } from '../event/event-bus';
import { BackgroundService, BackgroundTaskPersistence, IBackgroundService } from './background';
import {
  CompactionService,
  ICompactionService,
  IMicroCompactionService,
  MicroCompactionService,
} from './compaction';
import { AgentConfigService, IAgentConfigService } from './config';
import { ContextService, IContextService } from './context';
import { CronService, ICronService } from './cron';
import { GoalService, IGoalService } from './goal';
import { InjectionService, IInjectionService } from './injection/manager';
import { ILifecycleService, LifecycleService } from './lifecycle';
import { IPermissionService, PermissionService } from './permission';
import { IPlanService, PlanService } from './plan';
import {
  type AgentRecordPersistence,
  IRecordsService,
  RecordsService,
} from './records';
import { IReplayService, ReplayService } from './replay';
import { AgentSkillService, IAgentSkillService } from './skill';
import { AgentStatusService, IAgentStatusService, type AgentStatusHost } from './status';
import { ISwarmService, SwarmService } from './swarm';
import { AgentToolService, IAgentToolService } from './tool/index';
import { ITurnService, TurnService } from './turn';
import { IUsageService, UsageService } from './usage';
import type { Agent, AgentOptions } from './index';

/**
 * Builds the per-agent `ServiceCollection` (the ~18 `SyncDescriptor` registrations
 * plus the `IAgentSkillService` / `ICronService` conditionals) that the `Agent`
 * constructor turns into a child scope.
 *
 * This is the safe first half of M2.6: it only relocates the registration block.
 * The lazy-`this` injection is preserved — several descriptors still capture the
 * `agent` handle and deref fields (e.g. `agent.records`, `agent.eventBus`) that are
 * assigned *after* the scope is created. That is safe because the descriptors and
 * the closures are lazy: they only materialize / run after construction completes.
 * The two-phase-construction rewrite is deferred to M2.6b.
 */
export class AgentFactory {
  static buildServiceCollection(
    agent: Agent,
    options: AgentOptions,
    recordsPersistence: AgentRecordPersistence | undefined,
    backgroundPersistence: BackgroundTaskPersistence | undefined,
  ): ServiceCollection {
    const perAgentServices = new ServiceCollection();
    perAgentServices.set(IRecordsService, new SyncDescriptor(RecordsService, [agent, recordsPersistence]));
    perAgentServices.set(
      ICompactionService,
      new SyncDescriptor(CompactionService, [agent, options.compactionStrategy]),
    );
    perAgentServices.set(
      IMicroCompactionService,
      new SyncDescriptor(MicroCompactionService, [agent, options.microCompaction]),
    );
    perAgentServices.set(IContextService, new SyncDescriptor(ContextService, [agent]));
    perAgentServices.set(IAgentConfigService, new SyncDescriptor(AgentConfigService, [agent]));
    perAgentServices.set(ITurnService, new SyncDescriptor(TurnService, [agent]));
    perAgentServices.set(IInjectionService, new SyncDescriptor(InjectionService, [agent]));
    perAgentServices.set(
      IPermissionService,
      new SyncDescriptor(PermissionService, [agent, options.permission]),
    );
    perAgentServices.set(
      IAgentStatusService,
      new SyncDescriptor(AgentStatusService, [agent satisfies AgentStatusHost]),
    );
    perAgentServices.set(
      IPlanService,
      new SyncDescriptor(PlanService, [agent.kaos, agent.homedir]),
    );
    perAgentServices.set(ISwarmService, new SyncDescriptor(SwarmService));
    perAgentServices.set(IUsageService, new SyncDescriptor(UsageService));
    perAgentServices.set(IAgentToolService, new SyncDescriptor(AgentToolService, [agent]));
    perAgentServices.set(
      IBackgroundService,
      new SyncDescriptor(BackgroundService, [agent, backgroundPersistence]),
    );
    perAgentServices.set(IReplayService, new SyncDescriptor(ReplayService, [options.replay]));
    perAgentServices.set(
      IDomainEventBus,
      new SyncDescriptor(DomainEventBus, [
        (event: AgentEvent) => {
          if (!agent.records.restoring) void agent.rpc?.emitEvent?.(event);
        },
      ]),
    );
    perAgentServices.set(ILifecycleService, new SyncDescriptor(LifecycleService, []));
    perAgentServices.set(
      IGoalService,
      new SyncDescriptor(GoalService, [
        agent.telemetry,
        (event: AgentEvent) => {
          agent.eventBus.publish(event);
        },
      ]),
    );
    if (options.skills !== undefined) {
      perAgentServices.set(
        IAgentSkillService,
        new SyncDescriptor(AgentSkillService, [agent, options.skills]),
      );
    }
    if (agent.type !== 'sub') {
      perAgentServices.set(ICronService, new SyncDescriptor(CronService, [agent]));
    }
    return perAgentServices;
  }
}
