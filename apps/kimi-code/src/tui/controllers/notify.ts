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

export class NotifyController {
  private enabled = false;
  private mounted = false;
  private mainTurnId: number | undefined;
  private readonly running = new Map<string, number | undefined>();
  private readonly steps = new Map<string, number>();
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly settled = new Map<string, string>();
  private readonly endedTurns = new Map<string, number>();

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

  changePage(direction: -1 | 1): boolean {
    if (!this.enabled || !this.state.notifyPanel.changePage(direction)) return false;
    this.state.ui.requestRender();
    return true;
  }

  handleEvent(event: Event): void {
    if (!this.enabled) return;
    const agentId = event.agentId;
    // oxlint-disable-next-line typescript-eslint/switch-exhaustiveness-check -- Only progress and agent lifecycle events affect this projection.
    switch (event.type) {
      case 'subagent.spawned':
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
        if (update === undefined) return;
        this.pending.delete(key);
        this.settled.set(key, agentId);
        if (
          event.isError !== true &&
          event.synthetic !== true &&
          notifyResultState(event.output) === 'displayed'
        ) {
          const entry: NotifyEntry = { id: key, agentId, time: update.time, text: update.text };
          this.state.notifyPanel.upsert(entry);
        }
        break;
      }
      default:
        return;
    }
    this.render();
  }

  restore(snapshot: ResumedSessionState | undefined): void {
    if (!this.enabled || snapshot === undefined) return;
    this.reset();
    for (const agent of Object.values(snapshot.agents)) {
      for (const task of agent.background) {
        if (task.kind !== 'agent' || task.agentId === undefined) continue;
        if (!isTerminalBackgroundTask(task)) this.running.set(task.agentId, undefined);
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
