import type { Event, ResumedSessionState } from '@moonshot-ai/kimi-code-sdk';

import type { NotifyEntry } from '#/tui/components/chrome/notify-panel';
import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import type { TUIState } from '#/tui/tui-state';
import { argsRecord } from '#/tui/utils/event-payload';
import { notifyResultState } from '#/tui/utils/notify-result';
import { isTerminalBackgroundTask } from '#/tui/utils/message-replay';

interface PendingUpdate {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly time: number;
  readonly text: string;
}

/**
 * A harness-generated entry marking that work was delegated — shown
 * immediately (not result-gated like `NotifyUser` calls), because its whole
 * point is to explain the silence while the subagent runs.
 */
function delegationText(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'Agent') {
    const description = args['description'];
    if (typeof description !== 'string' || description.trim().length === 0) return undefined;
    const kind = typeof args['subagent_type'] === 'string' ? args['subagent_type'] : 'subagent';
    return `▸ Delegated to ${kind}: **${description.trim()}**`;
  }
  const items = args['items'];
  const newCount = Array.isArray(items) ? items.length : 0;
  const resumeIds = args['resume_agent_ids'];
  const resumedCount =
    resumeIds !== null && typeof resumeIds === 'object' && !Array.isArray(resumeIds)
      ? Object.keys(resumeIds).length
      : 0;
  const total = newCount + resumedCount;
  if (total === 0) return undefined;
  return `▸ Delegated to a swarm of ${String(total)} subagents`;
}

export class NotifyController {
  private enabled = false;
  private mounted = false;
  private mainTurnId: number | undefined;
  private readonly running = new Map<string, number | undefined>();
  private readonly steps = new Map<string, number>();
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly settled = new Map<string, string>();
  private readonly endedTurns = new Map<string, number>();
  private readonly agentNames = new Map<string, string>();

  constructor(
    private readonly state: Pick<TUIState, 'notifyPanel' | 'notifyPanelContainer' | 'ui'>,
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.reset();
    this.enabled = enabled;
  }

  reset(): void {
    this.running.clear();
    this.steps.clear();
    this.mainTurnId = undefined;
    this.clear();
    this.settled.clear();
    this.endedTurns.clear();
    this.agentNames.clear();
  }

  clear(): void {
    for (const [key, update] of this.pending) this.settled.set(key, update.agentId);
    this.pending.clear();
    if (!this.enabled && !this.mounted) return;
    const { notifyPanel, notifyPanelContainer } = this.state;
    if (notifyPanel.isEmpty() && notifyPanelContainer.children.length === 0) return;
    notifyPanel.clear();
    notifyPanelContainer.clear();
    this.mounted = false;
    this.state.ui.requestRender();
  }

  toggleFocus(): boolean {
    if (!this.enabled) return false;
    const panel = this.state.notifyPanel;
    const changed = panel.isFocused() ? panel.blur() : panel.focus();
    if (!changed) return false;
    this.state.ui.requestRender();
    return true;
  }

  handlePanelKey(key: 'left' | 'right' | 'up' | 'down' | 'escape'): boolean {
    if (!this.enabled || !this.state.notifyPanel.isFocused()) return false;
    const panel = this.state.notifyPanel;
    if (key === 'escape') panel.blur();
    else if (key === 'left') panel.prevChannel();
    else if (key === 'right') panel.nextChannel();
    else if (key === 'up') panel.prevPage();
    else panel.nextPage();
    this.state.ui.requestRender();
    return true;
  }

  handleEvent(event: Event): void {
    if (!this.enabled) return;
    const agentId = event.agentId;
    // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check -- Only progress and agent lifecycle events affect this projection.
    switch (event.type) {
      case 'subagent.spawned':
        this.agentNames.set(event.subagentId, event.subagentName);
        this.running.set(event.subagentId, undefined);
        break;
      case 'subagent.started':
        this.running.set(event.subagentId, undefined);
        break;
      case 'subagent.completed':
      case 'subagent.failed':
        this.running.delete(event.subagentId);
        this.dropPending(event.subagentId);
        break;
      case 'background.task.started':
      case 'background.task.terminated': {
        const { info } = event;
        if (info.kind !== 'agent' || info.agentId === undefined) return;
        if (isTerminalBackgroundTask(info)) {
          this.running.delete(info.agentId);
          this.dropPending(info.agentId);
        } else {
          this.running.set(info.agentId, this.running.get(info.agentId));
        }
        break;
      }
      case 'turn.started':
        if (
          (this.endedTurns.get(agentId) ?? -1) >= event.turnId ||
          (this.running.get(agentId) ?? -1) >= event.turnId
        )
          return;
        if (agentId === MAIN_AGENT_ID && this.mainTurnId !== event.turnId) {
          this.clear();
          this.mainTurnId = event.turnId;
        }
        this.dropPending(agentId);
        this.forgetSettled(agentId);
        this.running.set(agentId, event.turnId);
        this.steps.set(agentId, 0);
        break;
      case 'turn.ended':
        if (
          (this.endedTurns.get(agentId) ?? -1) >= event.turnId ||
          (this.running.get(agentId) ?? -1) > event.turnId
        )
          return;
        if (
          agentId === MAIN_AGENT_ID &&
          this.mainTurnId !== undefined &&
          this.mainTurnId !== event.turnId
        )
          return;
        if (this.running.get(agentId) === event.turnId || this.running.get(agentId) === undefined) {
          this.running.delete(agentId);
        }
        this.dropPending(agentId, event.turnId);
        this.endedTurns.set(agentId, event.turnId);
        this.forgetSettled(agentId);
        if (agentId === MAIN_AGENT_ID) this.state.notifyPanel.setEnded(true);
        break;
      case 'turn.step.started':
        this.steps.set(agentId, event.step);
        break;
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
        this.dropPending(agentId, event.turnId, event.step);
        break;
      case 'turn.step.completed':
        if (event.finishReason === 'max_tokens') {
          this.dropPending(agentId, event.turnId, event.step);
        }
        break;
      case 'tool.call.started': {
        if (
          (this.endedTurns.get(agentId) ?? -1) >= event.turnId ||
          (this.running.get(agentId) ?? -1) > event.turnId
        )
          return;
        if (agentId === MAIN_AGENT_ID && (event.name === 'Agent' || event.name === 'AgentSwarm')) {
          const text = delegationText(event.name, argsRecord(event.args));
          if (text !== undefined) {
            this.state.notifyPanel.upsert({
              id: `delegation:${String(event.turnId)}:${event.toolCallId}`,
              agentId,
              time: Date.now(),
              text,
            });
          }
          break;
        }
        const key = JSON.stringify([agentId, event.turnId, event.toolCallId]);
        if (this.settled.has(key)) return;
        if (event.name !== 'NotifyUser') return;
        const message = argsRecord(event.args)['message'];
        if (typeof message !== 'string' || message.trim().length === 0) return;
        this.pending.set(key, {
          agentId,
          turnId: event.turnId,
          step: this.steps.get(agentId) ?? 0,
          time: Date.now(),
          text: message,
        });
        break;
      }
      case 'tool.result': {
        const key = JSON.stringify([agentId, event.turnId, event.toolCallId]);
        const update = this.pending.get(key);
        if (update === undefined) {
          if (
            agentId === MAIN_AGENT_ID &&
            (event.isError === true || event.synthetic === true) &&
            this.state.notifyPanel.remove(`delegation:${String(event.turnId)}:${event.toolCallId}`)
          ) {
            this.render();
          }
          return;
        }
        this.pending.delete(key);
        this.settled.set(key, agentId);
        if (
          event.isError !== true &&
          event.synthetic !== true &&
          notifyResultState(event.output) === 'displayed'
        ) {
          const entry: NotifyEntry = {
            id: key,
            agentId,
            agentName: this.agentNames.get(agentId),
            time: update.time,
            text: update.text,
          };
          this.state.notifyPanel.upsert(entry);
        }
        break;
      }
      default:
        return;
    }
    if (this.running.size === 0) this.state.notifyPanel.setEnded(true);
    this.render();
  }

  restore(snapshot: ResumedSessionState | undefined): void {
    if (!this.enabled || snapshot === undefined) return;
    this.reset();
    for (const agent of Object.values(snapshot.agents)) {
      for (const task of agent.background) {
        if (task.kind !== 'agent' || task.agentId === undefined) continue;
        if (isTerminalBackgroundTask(task)) continue;
        this.running.set(task.agentId, undefined);
        if (task.subagentType !== undefined) this.agentNames.set(task.agentId, task.subagentType);
      }
    }
    this.render();
  }

  private dropPending(agentId: string, turnId?: number, step?: number): void {
    for (const [key, update] of this.pending) {
      if (
        update.agentId !== agentId ||
        (turnId !== undefined && update.turnId !== turnId) ||
        (step !== undefined && update.step !== step)
      )
        continue;
      this.pending.delete(key);
      this.settled.set(key, update.agentId);
    }
  }

  private forgetSettled(agentId: string): void {
    for (const [key, source] of this.settled) if (source === agentId) this.settled.delete(key);
  }

  private render(): void {
    const { notifyPanel, notifyPanelContainer, ui } = this.state;
    if (notifyPanel.isEmpty()) {
      if (notifyPanelContainer.children.length === 0) return;
      notifyPanelContainer.clear();
      this.mounted = false;
    } else {
      if (notifyPanelContainer.children.length === 0) notifyPanelContainer.addChild(notifyPanel);
      this.mounted = true;
    }
    ui.requestRender();
  }
}
