import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentTaskService } from '#/agent/task/task';
import type { ISessionEventBus } from '#/app/event/eventBus';
import { BROADCAST_NAME, TOWER_NAME } from '#/features/tower/protocol/index';
import type { TowerSendResult, TowerState } from '#/features/tower/protocol/index';
import { TowerInboxSent } from '#/features/tower/towerOps';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

const STEER_SUBJECT_PREVIEW_MAX = 120;

export interface TowerDeliveryServices {
  readonly sessionBus: ISessionEventBus | undefined;
  readonly tasks: IAgentTaskService | undefined;
  readonly agentLifecycle: IAgentLifecycleService;
  readonly state: TowerState;
}

export function deliverTowerMessage(
  services: TowerDeliveryServices,
  sent: TowerSendResult,
): string {
  const { item } = sent;
  if (
    services.sessionBus !== undefined &&
    item.from !== TOWER_NAME &&
    (item.to === TOWER_NAME || item.to === BROADCAST_NAME)
  ) {
    services.sessionBus.publish(
      new TowerInboxSent({
        from: item.from,
        to: item.to,
        subject: item.subject,
        messageId: item.messageId,
        file: item.file,
        sentAt: item.sentAt,
        missionId: sent.missionId,
      }),
    );
  }
  const entry =
    item.to === TOWER_NAME || item.to === BROADCAST_NAME
      ? undefined
      : services.state.roster.agents.find((agent) => agent.name === item.to);
  const undelivered =
    item.from === TOWER_NAME &&
    entry !== undefined &&
    services.tasks !== undefined &&
    !services.tasks
      .list(true)
      .some((task) => task.kind === 'agent' && task.agentId === entry.agentId);
  const note = undelivered
    ? `\nnote: ${item.to} has no running task in this session — the message sits in its inbox until you deliver it with Agent(resume="${entry.agentId}", run_in_background=true, prompt="...")`
    : '';
  return `${steerIntoRunningAgent(services, sent)}${note}`;
}

function steerIntoRunningAgent(
  services: TowerDeliveryServices,
  sent: TowerSendResult,
): string {
  const { item } = sent;
  if (item.to === TOWER_NAME || item.to === BROADCAST_NAME) return '';
  const entry = services.state.roster.agents.find((agent) => agent.name === item.to);
  if (entry === undefined) return '';
  try {
    const handle = services.agentLifecycle.handleOf(entry.agentId);
    if (handle === undefined) return '';
    const loop = handle.accessor.get(IAgentLoopService);
    if (loop.snapshot().state !== 'running') return '';
    const subject =
      item.subject.length > STEER_SUBJECT_PREVIEW_MAX
        ? `${item.subject.slice(0, STEER_SUBJECT_PREVIEW_MAX)}…`
        : item.subject;
    loop.submit(
      {
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[tower inbox] new message from ${item.from}: "${subject}" — read it now with TowerInbox and act on it before continuing.`,
            },
          ],
        },
        meta: { origin: { kind: 'injection', variant: 'tower_inbox_steer' } as PromptOrigin },
      },
      { steerIfActive: true },
    );
    return `\nnote: ${item.to} is mid-turn — the message was steered into its running turn; it sees the directive at its next step boundary.`;
  } catch {
    return '';
  }
}
