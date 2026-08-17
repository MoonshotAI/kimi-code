/**
 * `tools` domain — `TowerReviewTool` implementation (the `TowerReview`
 * tool).
 *
 * Submits the verdict through the protocol `TowerStore` rooted at the
 * session cwd (`sessionContext`), resolving the caller's roster identity
 * from the agent scope (`scopeContext`); only a "clean" review of the exact
 * current tip passes the merge gate. Registered for every agent — visibility
 * is controlled by profile tool lists. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './review.md?raw';
import {
  ITowerReviewTool,
  TowerReviewToolInputSchema,
  type TowerReviewToolInput,
} from './review';

export class TowerReviewTool implements ITowerReviewTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerReview' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerReviewToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerReviewToolInput): ToolExecution {
    return {
      description: `Submitting tower review for ${args.target}: ${args.status}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const rel = await store.submitReview(caller, {
            target: args.target,
            status: args.status,
            merge: args.merge,
            findings: args.findings,
            checks: args.checks,
            decision: args.decision,
          });
          return {
            output: `review submitted: ${rel}\nAlso notify the branch author (or the tower) with TowerSend so the verdict is seen.`,
          };
        }),
    };
  }
}

