import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { resolveMissionByBranch } from '#/features/tower/protocol/index';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, callerTokens, newTowerStore, runTowerTool } from '../support';
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
    @ISessionUsageService private readonly usage: ISessionUsageService,
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
            tokens: callerTokens(this.usage, agentContextOfScope(this.scopeContext)),
          });
          const lines = [`review submitted: ${rel}`];
          if (args.status === 'clean') {
            lines.push(
              `next: ${args.target} is merge-ready — the tower can TowerMerge it in Dependency Flow order.`,
            );
          } else {
            const owner = resolveMissionByBranch(state, args.target)?.owner;
            const worker = owner === undefined ? undefined : store.findAgent(state, owner);
            if (owner !== undefined && worker !== undefined) {
              lines.push(
                `next: resume ${owner} with this review file (${rel}): Agent(resume="${worker.agentId}", run_in_background=true, prompt="...") — never foreground: its output flows back through the tower protocol files. The branch must be fixed and re-reviewed before it can merge.`,
              );
            } else {
              lines.push(
                `next: no worker on record owns ${args.target} — route this review file (${rel}) through the tower so it can reassign the fixes.`,
              );
            }
          }
          lines.push(
            'Also notify the branch author (or the tower) with TowerSend so the verdict is seen.',
          );
          return { output: lines.join('\n') };
        }),
    };
  }
}

