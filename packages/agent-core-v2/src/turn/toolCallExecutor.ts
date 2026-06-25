/**
 * `turn` domain (L4) — `IToolCallExecutor` implementation.
 *
 * Runs a single tool call through its generic veto gate and fires the
 * surrounding turn events; executes tools through `tool`. The veto gate is
 * policy-agnostic — participants such as permission are subscribed by the
 * composition root, not hard-wired here. Bound at Turn scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { handleVetos } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IToolService } from '#/tool/tool';

import {
  type ToolCallOutcome,
  IToolCallExecutor,
  ITurnContext,
  ITurnEvents,
} from './turn';

type VetoEntry = { readonly value: boolean | Promise<boolean>; readonly id?: string };

export class ToolCallExecutor extends Disposable implements IToolCallExecutor {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ITurnEvents private readonly turnEvents: ITurnEvents,
    @IToolService private readonly tool: IToolService,
    @ITurnContext private readonly turnContext: ITurnContext,
  ) {
    super();
  }

  async execute(toolCallId: string, toolName: string, args: unknown): Promise<ToolCallOutcome> {
    const vetos: VetoEntry[] = [];
    const { turnId } = this.turnContext;

    this.turnEvents.fireWillExecuteTool({
      turnId,
      toolCallId,
      toolName,
      args,
      veto: (value, id) => {
        vetos.push({ value, id });
      },
    });

    if (await handleVetos(vetos.map((entry) => entry.value), onUnexpectedError)) {
      return { vetoed: true, reason: await this.resolveVetoReason(vetos) };
    }

    const result = await this.tool.execute(toolName, args);
    this.turnEvents.fireDidFinalizeTool({ turnId, toolCallId, toolName });
    return { vetoed: false, result };
  }

  private async resolveVetoReason(vetos: readonly VetoEntry[]): Promise<string> {
    for (const { value, id } of vetos) {
      if (await Promise.resolve(value)) {
        return id ?? 'vetoed';
      }
    }
    return 'vetoed';
  }
}

registerScopedService(LifecycleScope.Turn, IToolCallExecutor, ToolCallExecutor, InstantiationType.Delayed, 'turn');
