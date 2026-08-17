/**
 * `userTool` domain — `IAgentUserToolService` implementation.
 *
 * Holds the set of host-registered user tools in the `userToolKey` state
 * (`Map<string, UserToolRegistration>`), mutating it only through the durable
 * `ToolsRegisterUserTool` / `ToolsUnregisterUserTool` events
 * (`dispatcher.dispatch(...)`). The live side effects — `registry.register` +
 * `profile.addActiveTool` (and the matching dispose / `removeActiveTool`) — run
 * after the dispatch, and are re-derived from the rebuilt state by the
 * dispatcher's `onDidRestore` hook after restore, so a resumed agent
 * re-registers exactly the tools the persisted records describe without
 * re-firing any live notification.
 * The restore re-registers into the tool registry only: the active-tool set is
 * owned by the persisted `profileActiveToolsKey`, so the ephemeral `addActiveTool`
 * overlay is not rebuilt (it is live-only by design). The per-tool
 * `IDisposable` handles stay live-only (they cannot be persisted).
 * Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { IAgentProfileService } from '#/agent/profile/profile';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentUserToolService, type UserToolRegistration } from './userTool';
import {
  ToolsRegisterUserTool,
  ToolsUnregisterUserTool,
  userToolKey,
} from './userToolOps';

interface UserToolExecutionRequest {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export class AgentUserToolService extends Service implements IAgentUserToolService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<string, IDisposable>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(userToolKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('user-tool', async (_ctx, next) => {
        this.restoreRegisteredTools();
        await next();
      }),
    );
  }

  list(): readonly UserToolRegistration[] {
    return [...this.agentState.get(userToolKey).values()];
  }

  inheritUserTools(parent: IAgentUserToolService): void {
    for (const registration of parent.list()) {
      this.register(registration);
    }
  }

  register(input: UserToolRegistration): void {
    void this.dispatcher.dispatch(new ToolsRegisterUserTool(input));
    this.applyRegister(input);
  }

  unregister(name: string): void {
    void this.dispatcher.dispatch(new ToolsUnregisterUserTool({ name }));
    this.applyUnregister(name);
  }

  private restoreRegisteredTools(): void {
    const persistedActive = this.profile.getActiveToolNames();
    for (const registration of this.agentState.get(userToolKey).values()) {
      const activate =
        persistedActive === undefined || persistedActive.includes(registration.name);
      this.applyRegister(registration, { activate });
    }
  }

  private applyRegister(input: UserToolRegistration, options?: { readonly activate?: boolean }): void {
    const { name, description, parameters } = input;
    this.applyUnregister(name);
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => ({
        approvalRule: name,
        execute: (context) => this.executeUserTool(context, name, args),
      }),
    };
    this.registrations.set(
      name,
      this._register(
        this.registry.register(tool, { source: 'user', disclosure: input.disclosure }),
      ),
    );
    if (options?.activate === false) return;
    this.profile.addActiveTool(name);
  }

  private applyUnregister(name: string): void {
    const registration = this.registrations.get(name);
    if (registration === undefined) return;
    registration.dispose();
    this.registrations.delete(name);
    this.profile.removeActiveTool(name);
  }

  private async executeUserTool(
    context: ExecutableToolContext,
    name: string,
    args: unknown,
  ): Promise<ExecutableToolResult> {
    const id = `user_tool_${randomUUID()}`;
    const request = this.interaction.request<UserToolExecutionRequest, ExecutableToolResult>({
      id,
      kind: 'user_tool',
      payload: {
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        name,
        args,
      },
      origin: {
        turnId: context.turnId,
      },
    });
    try {
      return await abortable(request, context.signal);
    } catch (error) {
      if (context.signal.aborted) {
        this.interaction.respond(id, {
          output: `User tool "${name}" was aborted.`,
          isError: true,
        });
      }
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUserToolService,
  AgentUserToolService,
  ScopeActivation.OnScopeCreated,
  'userTool',
);
