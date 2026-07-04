/**
 * `contextOps` domain (L4) — `IAgentContextOpsService` contract.
 *
 * The standard positional context operations shared across domains:
 * `context.append` (append messages at the end), `context.remove` (remove
 * resolved index/id targets), `context.clear` (drop the whole history and cut
 * the replay segment), and `context.append_system_reminder` (append a
 * `<system-reminder>` user message). The legacy `context.replace` replay
 * operation is registered by the implementation for old migrated wire only.
 * Owning them in one service gives every migrated record type a single
 * registrant that the restore preamble can resolve before replaying the wire
 * log.
 */

import { createDecorator } from "#/_base/di";
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';

export type ContextAppendArgs = readonly ContextMessage[];
export type ContextAppendSystemReminderArgs = [message: string, origin: PromptOrigin];
export type ContextReplaceArgs = [index: number, message: ContextMessage];

/**
 * One resolved removal target. `index` is the position at the moment the
 * removal applies — a multi-target removal lists indices in descending order
 * so earlier removals do not shift later ones. `messageId` identifies the
 * message in the replay read model.
 */
export interface ContextRemovalTarget {
  readonly index: number;
  readonly messageId?: string;
}

export type ContextRemoveArgs = [removals: readonly ContextRemovalTarget[]];
export type ContextClearArgs = [];

export interface IAgentContextOpsService {
  readonly _serviceBrand: undefined;

  /** Append messages at the end of the history (ids stamped when missing). */
  append(...messages: readonly ContextMessage[]): void;

  /**
   * Append a `<system-reminder>` message to the end of the history.
   * Returns the message inserted into history.
   */
  appendSystemReminder(content: string, origin: PromptOrigin): ContextMessage;

  /** Remove the resolved targets (descending indices) from the history. */
  remove(removals: readonly ContextRemovalTarget[]): void;

  /** Drop the whole history; replay cuts a new segment at this point. */
  clear(): void;
}

export const IAgentContextOpsService = createDecorator<IAgentContextOpsService>('agentContextOpsService');
