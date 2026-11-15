import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { historyEntryFromContext } from '#/agent/loop/history';
import { isUserCancellation } from '#/_base/utils/abort';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentInterruptionReminderService } from './interruptionReminder';
import { InterruptionCancellationRequested, InterruptionReminderRecorded, INTERRUPTION_REMINDER_VARIANT, interruptionReminderKey } from './interruptionReminderOps';

const INTERRUPTION_REMINDER = [
  'The previous turn was interrupted by the user before completion;',
  'any partial output shown above is incomplete.',
  "The user's next message continues the conversation.",
].join(' ');

export class AgentInterruptionReminderService
  extends Disposable
  implements IAgentInterruptionReminderService
{
  declare readonly _serviceBrand: undefined;

  private readonly appendedTurns = new Set<number>();

  constructor(
    @IAgentLoopService private readonly context: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService states: IAgentStateService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
    states.contributeState(interruptionReminderKey);
  }

  notifyUserCancellation(reason: unknown): void {
    if (!isUserCancellation(reason)) return;
    const snapshot = this.context.snapshot();
    const turnId = snapshot.activeTurnId;
    if (turnId === undefined || this.appendedTurns.has(turnId)) return;
    this.appendedTurns.add(turnId);
    const agentId = this.scopeContext.agentId;
    void this.dispatcher.dispatch(new InterruptionCancellationRequested({
      agentId,
      turnId,
      ownerPromptId: snapshot.activePromptId,
    }));
    void this.dispatcher.dispatch(new InterruptionReminderRecorded({ agentId, turnId }));
    this.context.remind(historyEntryFromContext({
      role: 'user',
      content: [{ type: 'text', text: wrapSystemReminder(INTERRUPTION_REMINDER) }],
      origin: {
        kind: 'injection',
        variant: INTERRUPTION_REMINDER_VARIANT,
        ownerPromptId: snapshot.activePromptId,
      },
    }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentInterruptionReminderService,
  AgentInterruptionReminderService,
  ScopeActivation.OnScopeCreated,
  'interruptionReminder',
);
