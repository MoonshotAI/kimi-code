import type { HistoryMessage, UserEntry } from '@moonshot-ai/core/llm/history';
import type { IWireService } from '#/wire/wire';
import { contextFromHistoryEntry } from '#/agent/loop/history';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { AgentTaskService } from './taskService';
import { TERMINAL_STATUSES } from './types';
import { IAgentTaskOutputService } from './taskOutput';

export async function restoreTaskCompletions(options: {
  readonly wire: IWireService;
  readonly agentId: string;
  readonly taskOutputs: IAgentTaskOutputService;
  readonly messages: readonly HistoryMessage[];
  readonly pending?: readonly HistoryMessage[];
  readonly isLive?: (taskId: string) => boolean;
}): Promise<readonly UserEntry[]> {
  const { journal, restorable } = await options.wire.readRestoreChains();
  const history = new AgentTaskService(options.agentId);
  history.restore(journal);
  const delivered = new Set<string>();
  const recordDelivery = (origin: PromptOrigin | undefined): void => {
    if (origin?.kind === 'task') delivered.add(`${origin.taskId}\0${origin.status}\0${origin.notificationId}`);
  };
  for (const entry of [...options.messages, ...options.pending ?? []]) {
    recordDelivery(contextFromHistoryEntry(entry).origin);
  }
  for (const record of journal) {
    if (record['agentId'] !== undefined && record['agentId'] !== options.agentId) continue;
    if (record.type !== 'context.append_message') continue;
    recordDelivery((record['message'] as ContextMessage | undefined)?.origin);
  }
  for (const record of restorable) {
    if (record.type !== 'task.waitDelivered' || record['agentId'] !== options.agentId) continue;
    const keys = record['keys'];
    if (!Array.isArray(keys)) continue;
    for (const key of keys) {
      if (typeof key === 'string') delivered.add(key);
    }
  }
  const completions: UserEntry[] = [];
  for (const info of history.list(false)) {
    if (!TERMINAL_STATUSES.has(info.status)) continue;
    if (info.status === 'lost' && options.isLive?.(info.taskId) === true) continue;
    if (info.detached === false || info.terminalNotificationSuppressed === true) continue;
    const notificationId = `task:${info.taskId}:${info.status}`;
    if (delivered.has(`${info.taskId}\0${info.status}\0${notificationId}`)) continue;
    const toolCallId = info.kind === 'question' ? info.toolCallId ?? info.taskId : info.parentToolCallId ?? info.taskId;
    if (toolCallId === undefined) continue;
    completions.push(await options.taskOutputs.createCompletion(info, toolCallId));
  }
  return completions;
}
