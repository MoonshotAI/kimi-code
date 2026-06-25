import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  type IDisposable,
} from "#/_base/di";
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
} from '../../../loop';
import { IProfileService } from '../profile/profile';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { ToolResult } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IUserToolService,
  type UserToolRegistration,
  type UserToolServiceOptions,
} from './userTool';

declare module '../types' {
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
    private readonly options: UserToolServiceOptions = {},
    @IToolRegistry private readonly registry: IToolRegistry,
    @IProfileService private readonly profile: IProfileService,
    @IWireRecord private readonly wireRecord: IWireRecord,
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
    const executeUserTool = this.options.executeUserTool;
    if (executeUserTool === undefined) {
      return {
        output: `Tool "${name}" is not connected to a user tool executor.`,
        isError: true,
      };
    }
    return executeUserTool(
      {
        turnId: Number(context.turnId),
        toolCallId: context.toolCallId,
        args,
      },
      { signal: context.signal },
    );
  }
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

registerSingleton(IUserToolService, new SyncDescriptor(UserToolService, [{}], false));
