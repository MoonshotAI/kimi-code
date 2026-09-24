import { IAgentLoopService } from '#/agent/loop/loop';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { BROADCAST_NAME, TOWER_NAME } from '#/features/tower/protocol/index';
import type { TowerState } from '#/features/tower/protocol/index';
import { TowerInboxSent } from '#/features/tower/towerOps';
import { callerName, callerTokens, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './send.md?raw';
import { ITowerSendTool, TowerSendToolInputSchema, type TowerSendToolInput } from './send';

const STEER_SUBJECT_PREVIEW_MAX = 120;

export class TowerSendTool implements ITowerSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerSend' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSendToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TowerSendToolInput): ToolExecution {
    return {
      description: `Sending tower message to ${args.to}: ${args.subject}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const to = args.to.trim();
          const rel = await store.send(caller, {
            to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
            tokens: callerTokens(this.usage, agentContextOfScope(this.scopeContext)),
          });
          if (
            this.sessionBus !== undefined &&
            caller !== TOWER_NAME &&
            (to === TOWER_NAME || to === BROADCAST_NAME)
          ) {
            this.sessionBus.publish(new TowerInboxSent({ from: caller, to, subject: args.subject }));
          }
          const entry =
            caller === TOWER_NAME && to !== TOWER_NAME && to !== BROADCAST_NAME
              ? state.roster.agents.find((agent) => agent.name === to)
              : undefined;
          const undelivered =
            entry !== undefined &&
            this.tasks !== undefined &&
            !this.tasks
              .list(true)
              .some((task) => task.kind === 'agent' && task.agentId === entry.agentId);
          const note = undelivered
            ? `\nnote: ${to} has no running task in this session — the message sits in its inbox until you deliver it with Agent(resume="${entry.agentId}", run_in_background=true, prompt="...")`
            : '';
          const steered = this.steerIntoRunningAgent(state, caller, to, args);
          return { output: `message sent to ${args.to}\nfile: ${rel}${steered}${note}` };
        }),
    };
  }

  private steerIntoRunningAgent(
    state: TowerState,
    caller: string,
    to: string,
    args: TowerSendToolInput,
  ): string {
    if (to === TOWER_NAME || to === BROADCAST_NAME) return '';
    const entry = state.roster.agents.find((agent) => agent.name === to);
    if (entry === undefined) return '';
    try {
      const handle = this.agentLifecycle.handleOf(entry.agentId);
      if (handle === undefined) return '';
      const loop = handle.accessor.get(IAgentLoopService);
      if (loop.snapshot().state !== 'running') return '';
      const subject =
        args.subject.length > STEER_SUBJECT_PREVIEW_MAX
          ? `${args.subject.slice(0, STEER_SUBJECT_PREVIEW_MAX)}…`
          : args.subject;
      const urgency = args.urgent === true ? 'URGENT: act on this before anything else. ' : '';
      loop.submit(
        {
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${urgency}[tower inbox] new message from ${caller}: "${subject}" — read it now with TowerInbox and act on it before continuing.`,
              },
            ],
          },
          meta: { origin: { kind: 'injection', variant: 'tower_inbox_steer' } as PromptOrigin },
        },
        { steerIfActive: true },
      );
      const abortHint =
        args.urgent === true
          ? ' The in-flight tool call still finishes first — urgent does not abort it; for a hard abort, TaskStop the task and resume the agent with this message.'
          : '';
      return `\nnote: ${to} is mid-turn — the message was steered into its running turn; it sees the directive at its next step boundary.${abortHint}`;
    } catch {
      return '';
    }
  }
}

