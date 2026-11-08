import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import type {
  LegacyToolAgentContext,
  LegacyToolFields,
  LegacyToolPreparation,
} from '#/tool/executor';
import type {
  ToolExecutionHandler,
  ToolExecutor,
  ToolExecutorHook,
} from '#/tool/executor';

export type AgentToolHook = ToolExecutorHook<LegacyToolAgentContext, LegacyToolPreparation>;
export type AgentToolExecutionHandler = ToolExecutionHandler<LegacyToolFields, LegacyToolPreparation>;
export type AgentToolExecutor = ToolExecutor<LegacyToolAgentContext>;
export type ToolCallDupType = 'cross_step';

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;
  readonly executor: AgentToolExecutor;
  registerHook(hook: AgentToolHook): IDisposable;
  registerLegacyStarting(listener: (event: BeforeToolExecuteEvent) => void | Promise<void>): IDisposable;
  handler(taskId: string): AgentToolExecutionHandler | undefined;
  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined;
  release(taskId: string): void;
  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
