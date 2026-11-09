import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import type { AgentTaskFields } from '#/agent/task/handler';
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

export interface AgentToolFields extends LegacyToolFields {
  readonly task?: AgentTaskFields;
}

export type AgentToolHook = ToolExecutorHook<LegacyToolAgentContext, LegacyToolPreparation>;
export type AgentToolExecutionHandler = ToolExecutionHandler<AgentToolFields, LegacyToolPreparation>;
export type AgentToolExecutor = ToolExecutor<LegacyToolAgentContext>;
export type ToolCallDupType = 'cross_step';

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;
  readonly executor: AgentToolExecutor;
  registerHook(hook: AgentToolHook): IDisposable;
  registerLegacyStarting(listener: (event: BeforeToolExecuteEvent) => void | Promise<void>): IDisposable;
  handlers(): readonly AgentToolExecutionHandler[];
  handler(taskId: string): AgentToolExecutionHandler | undefined;
  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined;
  release(taskId: string): void;
  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
