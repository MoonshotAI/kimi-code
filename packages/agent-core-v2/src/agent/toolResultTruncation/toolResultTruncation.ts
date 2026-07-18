/**
 * `toolResultTruncation` domain (L3) — model-context truncation contract for tool results.
 *
 * Defines the Agent-scoped service that runs after tool execution hooks and
 * before a result is recorded into model-visible context. It preserves complete
 * oversized text results through agent-scoped storage, replacing the inline
 * payload with a recoverable preview and `output_path`. Pure contract; the
 * implementation owns persistence through the storage backend.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ExecutableToolResult } from '#/tool/toolContract';

export interface ToolResultTruncationInput<
  T extends ExecutableToolResult = ExecutableToolResult,
> {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: T;
}

export interface IAgentToolResultTruncationService {
  readonly _serviceBrand: undefined;

  truncateForModel<T extends ExecutableToolResult>(
    input: ToolResultTruncationInput<T>,
  ): Promise<T>;
}

export const IAgentToolResultTruncationService: ServiceIdentifier<
  IAgentToolResultTruncationService
> = createDecorator<IAgentToolResultTruncationService>('agentToolResultTruncationService');
