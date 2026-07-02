/**
 * `agentTool` domain (L5) — registers the `Agent` collaboration tool for an agent.
 *
 * Registers the `Agent` tool into the `toolRegistry` so the agent can spawn task
 * subagents, bound to this agent as the caller (`callerAgentId` from the agent
 * `scopeContext`). The optional first static `runner` argument is a test seam
 * (`AgentToolRunOverride`) that lets tests substitute the `runChildAgent`
 * helpers; the scoped registry supplies none. Bound at Agent scope; reads its
 * identity through `scopeContext`, creates child agents through
 * `agent-lifecycle`, reads the parent check through `session-metadata`, gates
 * background execution through the agent `profile`, and gathers git context
 * through `kaos` (cwd) + `process` (runner).
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBackgroundService } from '#/agent/background';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IExecContext } from '#/session/execContext';
import { ILogService } from '#/app/log';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionMetadata } from '#/session/session-metadata';

import { AgentTool } from './agentTool';
import { IAgentToolService } from './agentToolServiceToken';
import type { AgentToolRunOverride } from './runChildAgent';

export class AgentToolService extends Disposable implements IAgentToolService {
  declare readonly _serviceBrand: undefined;

  constructor(
    runner: AgentToolRunOverride | undefined,
    @IAgentScopeContext ctx: IAgentScopeContext,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
    @ISessionMetadata metadata: ISessionMetadata,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentBackgroundService background: IAgentBackgroundService,
    @IAgentProfileService profile: IAgentProfileService,
    @IExecContext execContext: IExecContext,
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
    @ILogService log?: ILogService,
  ) {
    super();
    this._register(
      toolRegistry.register(
        new AgentTool({
          lifecycle,
          callerAgentId: ctx.agentId,
          metadata,
          background,
          profile,
          cwd: execContext.cwd,
          processRunner,
          log,
          runOverride: runner,
        }),
      ),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolService,
  AgentToolService,
  InstantiationType.Delayed,
  'agentTool',
);
