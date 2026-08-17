/**
 * `tools` domain — `TowerSendTool` implementation (the `TowerSend` tool).
 *
 * Delivers the message through the protocol `TowerStore` rooted at the
 * session cwd (`sessionContext`), resolving the caller's roster identity
 * from the agent scope (`scopeContext`). Registered for every agent —
 * visibility is controlled by profile tool lists. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

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
          const rel = await store.send(caller, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
          });
          return { output: `message sent to ${args.to}\nfile: ${rel}` };
        }),
    };
  }
}

