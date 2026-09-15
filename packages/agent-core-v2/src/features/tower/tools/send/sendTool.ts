import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { BROADCAST_NAME, TOWER_NAME } from '#/features/tower/protocol/index';
import { TowerInboxSent } from '#/features/tower/towerOps';
import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './send.md?raw';
import { ITowerSendTool, TowerSendToolInputSchema, type TowerSendToolInput } from './send';

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
          return { output: `message sent to ${args.to}\nfile: ${rel}${note}` };
        }),
    };
  }
}

