import { fromCallback } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IGitService } from '#/app/git/git';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { getLoopControl } from '#/features/loop/internal/access';
import { TurnEnded } from '#/features/loop/turnOps';

import { ToolCatalog } from '#/features/toolExecutor/internal/catalog';
import { ToolExecutorPipeline } from '#/features/toolExecutor/internal/executor';
import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
} from '#/features/toolExecutor/toolExecutor';
import { ToolExecutionPermissionPolicyChain } from '#/features/toolExecutor/internal/permissionPolicy';
import { ToolExecutionPermissionGatePolicy } from '#/features/toolExecutor/internal/permissionGate';
import { ToolDedupePolicy } from '#/features/toolExecutor/internal/toolDedupe';
import { AgentToolsPolicy } from '#/features/toolExecutor/internal/toolPolicy';
import { SELECT_TOOLS_TOOL_NAME } from '#/features/toolExecutor/toolSelection';
import { AgentToolsSelection } from '#/features/toolExecutor/internal/selection';
import { IAgentToolContributionSource } from '#/agent/toolRegistry/toolContributionSourceService';
import { McpToolProvider } from '#/features/toolExecutor/internal/mcpToolProvider';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import {
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  LOADABLE_TOOLS_VARIANT,
} from '#/agent/toolSelect/dynamicTools';

export class ToolExecutorDomain {
  readonly catalog: ToolCatalog;
  readonly policy: AgentToolsPolicy;
  readonly pipeline: ToolExecutorPipeline;
  readonly selection: AgentToolsSelection;
  readonly mcp: McpToolProvider;
  readonly dedupe: ToolDedupePolicy;

  constructor(readonly runtime: AgentRuntimeContext<unknown>) {
    const host = runtime.get(IAgentHostService).of(runtime.agent);
    this.policy = new AgentToolsPolicy(runtime);
    this.catalog = new ToolCatalog(runtime, {
      agent: runtime.agent,
      host,
      get: (id) => runtime.get(id),
      enabled: () => this.selection.enabled(),
      load: (names) => this.selection.load(names),
      isActive: (name, source) => this.policy.isActive(name, source),
      isActiveForProfile: (profile, name, source) =>
        this.policy.isActiveForProfile(profile, name, source),
      contributions: () => runtime.get(IAgentToolContributionSource).view.items,
      resolve: (name) => this.catalog.resolve(name),
      listReferences: () => this.catalog.listReferences(),
    }, (record) => {
      const required = record.options.requiredRuntimeCapabilities;
      const runtimeAllowed = required === undefined || host.agentRuntime.isAvailable(required);
      return runtimeAllowed && this.policy.isActive(
        record.options.name,
        record.options.source ?? 'builtin',
      );
    });
    this.pipeline = new ToolExecutorPipeline(runtime, this.catalog);
    this.selection = new AgentToolsSelection(runtime, this.catalog, this.policy, this.pipeline);
    this.mcp = new McpToolProvider(runtime, this.catalog, this.pipeline);
    this.pipeline.registerToolCallGuard(({ name, source }) => {
      const active = name === SELECT_TOOLS_TOOL_NAME
        ? this.policy.isActiveForDisclosure(name, source)
        : this.policy.isActive(name, source);
      return active ? undefined : `Tool "${name}" is disabled by the active tool policy`;
    });
    const policyChain = new ToolExecutionPermissionPolicyChain(
      runtime.get(IAgentLifecycleService),
      host.scopeContext,
      host.agentRuntime,
      runtime.get(ISessionWorkspaceContext),
      runtime.get(IGitService),
    );
    const gate = new ToolExecutionPermissionGatePolicy(runtime, policyChain);
    this.dedupe = new ToolDedupePolicy(runtime, this.pipeline);
    this.pipeline.beforeExecuteBus.register(PERMISSION_GATE_PARTICIPANT, (event) =>
      gate.adjudicate(event),
    );
    this.pipeline.beforeExecuteBus.register(TOOL_DEDUPE_PARTICIPANT, this.dedupe.checkExecution);
    this.pipeline.registerDidExecuteHook(TOOL_DEDUPE_PARTICIPANT, this.dedupe.finalizeExecution);
  }
}

export const toolExecutorEffects = fromCallback(
  ({ input }: { input: ToolExecutorDomain }) => {
    const host = input.runtime.get(IAgentHostService).of(input.runtime.agent);
    const loop = getLoopControl(input.runtime.agent);
    input.catalog.activateContributions();
    const lifecycle = input.runtime.get(IAgentLifecycleService);
    const disposables: IDisposable[] = [
      host.eventBus.subscribe(TurnEnded, () => {
        input.dedupe.clearTurnRecords();
      }),
      loop.hooks.onWillBeginStep.register(TOOL_DEDUPE_PARTICIPANT, async (ctx, next) => {
        input.dedupe.beginStep(ctx.turnId, ctx.step);
        await next();
      }),
      loop.hooks.onDidFinishStep.register(TOOL_DEDUPE_PARTICIPANT, async (_ctx, next) => {
        input.dedupe.endStep();
        await next();
      }),
      activateReminderWhenReady(lifecycle, host.scopeContext, (reminder) =>
        reminder.register(LOADABLE_TOOLS_VARIANT, ({ isNewTurn }) =>
          isNewTurn
            ? input.selection.loadableToolsAnnouncement()
            : undefined,
        ),
      ),
      activateReminderWhenReady(lifecycle, host.scopeContext, (reminder) =>
        reminder.register(DYNAMIC_TOOL_SCHEMA_VARIANT, () => {
          const tools = input.selection.drainPendingToolSchemas();
          if (tools === undefined) return undefined;
          return { message: { role: 'system', content: [], tools } };
        }),
      ),
    ];
    return () => {
      for (let index = disposables.length - 1; index >= 0; index -= 1) {
        disposables[index]!.dispose();
      }
      input.mcp.dispose();
      input.selection.dispose();
      input.catalog.dispose();
    };
  },
);
