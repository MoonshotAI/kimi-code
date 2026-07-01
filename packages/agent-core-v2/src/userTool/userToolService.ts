import {
  Disposable,
  type IDisposable,
} from '#/_base/di';
import { abortable } from '#/_base/utils/abort';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolResult,
} from '#/tool';
import { IInteractionService } from '#/interaction';
import { IProfileService } from '#/profile';
import { IToolRegistry } from '#/toolRegistry';
import { IWireRecord } from '#/wireRecord';
import {
  IUserToolService,
  type UserToolRegistration,
} from './userTool';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

interface UserToolExecutionRequest {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

declare module '#/wireRecord' {
  interface WireRecordMap {
    'tools.register_user_tool': UserToolRegistration;
    'tools.unregister_user_tool': {
      readonly name: string;
    };
  }
}

export class UserToolService extends Disposable implements IUserToolService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<string, IDisposable>();

  constructor(
    @IToolRegistry private readonly registry: IToolRegistry,
    @IProfileService private readonly profile: IProfileService,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IInteractionService private readonly interaction: IInteractionService,
  ) {
    super();
    this._register(
      wireRecord.register('tools.register_user_tool', (record) => {
        this.applyRegister(record);
      }),
    );
    this._register(
      wireRecord.register('tools.unregister_user_tool', (record) => {
        this.applyUnregister(record.name);
      }),
    );
  }

  register(input: UserToolRegistration): void {
    this.wireRecord.append({ type: 'tools.register_user_tool', ...input });
    this.applyRegister(input);
  }

  unregister(name: string): void {
    this.wireRecord.append({ type: 'tools.unregister_user_tool', name });
    this.applyUnregister(name);
  }

  private applyRegister(input: UserToolRegistration): void {
    const { name, description, parameters } = input;
    this.applyUnregister(name);
    const tool: ExecutableTool = {
      name,
      description,
      parameters,
      resolveExecution: (args) => ({
        approvalRule: name,
        execute: async (context) =>
          toExecutableToolResult(await this.executeUserTool(context, name, args)),
      }),
    };
    this.registrations.set(name, this._register(this.registry.register(tool, { source: 'user' })));
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
  ): Promise<ToolResult> {
    const request = this.interaction.request<UserToolExecutionRequest, ToolResult>({
      id: context.toolCallId,
      kind: 'user_tool',
      payload: {
        turnId: numericTurnId(context.turnId),
        toolCallId: context.toolCallId,
        name,
        args,
      },
      origin: {
        turnId: numericTurnId(context.turnId),
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

function numericTurnId(turnId: string): number | undefined {
  const parsed = Number(turnId);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toExecutableToolResult(result: ToolResult): ExecutableToolResult {
  if (result.isError === true) {
    return {
      output: result.output,
      isError: true,
      message: result.message,
      stopTurn: result.stopTurn,
    };
  }
  return {
    output: result.output,
    message: result.message,
    stopTurn: result.stopTurn,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IUserToolService,
  UserToolService,
  InstantiationType.Eager,
  'userTool',
);
