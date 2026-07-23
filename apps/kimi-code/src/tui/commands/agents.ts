import type { AgentBackgroundTaskInfo, BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';

import { UsagePanelComponent } from '../components/messages/usage-panel';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const AGENTS_USAGE = 'Usage: /agents [status]';

export async function handleAgentsCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim().toLowerCase();
  if (command.length > 0 && command !== 'status') {
    host.showError(AGENTS_USAGE);
    return;
  }

  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  let tasks: readonly BackgroundTaskInfo[];
  try {
    tasks = await host.requireSession().listBackgroundTasks({ activeOnly: false });
  } catch (error) {
    host.showError(`Failed to load subagents: ${formatErrorMessage(error)}`);
    return;
  }

  const agents = tasks.filter((task): task is AgentBackgroundTaskInfo => task.kind === 'agent');
  const title = agents.length > 0 ? ` Agents (${agents.length}) ` : ' Agents ';
  host.state.transcriptContainer.addChild(
    new UsagePanelComponent(() => buildAgentStatusReportLines(agents), 'primary', title),
  );
  host.state.ui.requestRender();
}

export function buildAgentStatusReportLines(tasks: readonly AgentBackgroundTaskInfo[]): string[] {
  if (tasks.length === 0) return ['No background subagents.'];

  return tasks.flatMap((task) => {
    const agentId = task.agentId ?? task.taskId;
    const subagentType = task.subagentType ?? 'agent';
    const lines = [`${task.status}  ${subagentType}  ${agentId}  ${task.description}`];
    if (task.status === 'failed' && task.agentId !== undefined) {
      lines.push(`  Resume: ask Kimi to call Agent(resume="${task.agentId}", prompt="...")`);
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      lines.push(`  Reason: ${task.stopReason}`);
    }
    return lines;
  });
}
