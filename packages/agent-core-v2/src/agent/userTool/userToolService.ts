/**
 * `userTool` domain (L4) — `IAgentUserToolService` implementation.
 *
 * Holds the set of host-registered user tools in the `wire` `UserToolModel`
 * (`Map<string, UserToolRegistration>`), mutating it only through the
 * `tools.register_user_tool` / `tools.unregister_user_tool` Ops
 * (`wire.dispatch(...)`). The live side effects — `registry.register` +
 * `profile.addActiveTool` (and the matching dispose / `removeActiveTool`) — run
 * after the dispatch, and are re-derived from the rebuilt Model by
 * `wire.onRestored` after `wire.replay`, so a resumed agent re-registers exactly
 * the tools the persisted ops describe without re-firing any live notification.
 * The restore re-registers into the tool registry only: the active-tool set is
 * owned by the persisted `ActiveToolsModel`, so the ephemeral `addActiveTool`
 * overlay is not rebuilt (it is live-only by design). The per-tool
 * `IDisposable` handles stay live-only (they cannot be persisted).
 * Bound at Agent scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { IAgentProfileService } from '#/agent/profile/profile';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { IAgentUserToolService, type UserToolRegistration } from './userTool';
import { registerUserTool, unregisterUserTool, UserToolModel } from './userToolOps';

interface UserToolExecutionRequest {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export class AgentUserToolService extends Disposable implements IAgentUserToolService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<string, IDisposable>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @IAgentWireService private readonly wire: IWireService,
  ) {
    super();
    this._register(this.wire.onRestored(() => this.restoreRegisteredTools()));
  }

  list(): readonly UserToolRegistration[] {
    return [...this.wire.getModel(UserToolModel).values()];
  }

  inheritUserTools(parent: IAgentUserToolService): void {
    for (const registration of parent.list()) {
      this.register(registration);
    }
  }

  register(input: UserToolRegistration): void {
    this.wire.dispatch(registerUserTool(input));
    this.applyRegister(input);
  }

  unregister(name: string): void {
    this.wire.dispatch(unregisterUserTool({ name }));
    this.applyUnregister(name);
  }

  private restoreRegisteredTools(): void {
    const persistedActive = this.profile.getActiveToolNames();
    for (const registration of this.wire.getModel(UserToolModel).values()) {
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
    this.registrations.set(name, this._register(this.registry.register(tool, { source: 'user' })));
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
    const request = this.interaction.request<UserToolExecutionRequest, ExecutableToolResult>({
      id: context.toolCallId,
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
        this.interaction.respond(context.toolCallId, {
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
  InstantiationType.Eager,
  'userTool',
);
