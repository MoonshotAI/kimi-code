import type { HistoryMessage, UserEntry } from '#human/agent/turn';
import type { IWireService } from '#/wire/wire';
import { contextFromHistoryEntry } from '#/agent/loop/history';
import { AgentTaskService } from './taskService';
import { TERMINAL_STATUSES } from './types';
import { IAgentTaskOutputService } from './taskOutput';

export async function restoreTaskCompletions(options: {
  readonly wire: IWireService;
  readonly agentId: string;
  readonly taskOutputs: IAgentTaskOutputService;
  readonly messages: readonly HistoryMessage[];
}): Promise<readonly UserEntry[]> {
  const { journal } = await options.wire.readRestoreChains();
  const history = new AgentTaskService(options.agentId);
  history.restore(journal);
  const delivered = new Set<string>();
  for (const entry of options.messages) {
    const origin = contextFromHistoryEntry(entry).origin;
    if (origin?.kind === 'task') delivered.add(`${origin.taskId}\0${origin.status}\0${origin.notificationId}`);
  }
  const completions: UserEntry[] = [];
  for (const info of history.list(false)) {
    if (info.status === 'lost' || !TERMINAL_STATUSES.has(info.status)) continue;
    if (info.detached === false || info.terminalNotificationSuppressed === true) continue;
    const notificationId = `task:${info.taskId}:${info.status}`;
    if (delivered.has(`${info.taskId}\0${info.status}\0${notificationId}`)) continue;
    const toolCallId = info.kind === 'question' ? info.toolCallId : info.parentToolCallId;
    if (toolCallId === undefined) continue;
    completions.push(await options.taskOutputs.createCompletion(info, toolCallId));
  }
  return completions;
}
