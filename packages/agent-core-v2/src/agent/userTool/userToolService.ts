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
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
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

  inheritUserTools(
    parent: IAgentUserToolService,
    activeToolNames?: readonly string[],
  ): void {
    for (const registration of parent.list()) {
      void this.dispatcher.dispatch(
        new ToolsRegisterUserTool({ ...registration, agentId: this.scopeContext.agentId }),
      );
      const activate =
        activeToolNames === undefined || activeToolNames.includes(registration.name);
      this.applyRegister(registration, { activate });
    }
  }

  register(input: UserToolRegistration): void {
    void this.dispatcher.dispatch(
      new ToolsRegisterUserTool({ ...input, agentId: this.scopeContext.agentId }),
    );
    this.applyRegister(input);
  }

  unregister(name: string): void {
    void this.dispatcher.dispatch(
      new ToolsUnregisterUserTool({ agentId: this.scopeContext.agentId, name }),
    );
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
