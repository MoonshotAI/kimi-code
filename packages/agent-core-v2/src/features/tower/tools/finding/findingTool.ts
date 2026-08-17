/**
 * `tools` domain — `TowerFindingTool` implementation (the `TowerFinding`
 * tool).
 *
 * Files the finding through the protocol `TowerStore` rooted at the session
 * cwd (`sessionContext`), resolving the caller's roster identity from the
 * agent scope (`scopeContext`). Registered for every agent — visibility is
 * controlled by profile tool lists. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './finding.md?raw';
import {
  ITowerFindingTool,
  TowerFindingToolInputSchema,
  type TowerFindingToolInput,
} from './finding';

export class TowerFindingTool implements ITowerFindingTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerFinding' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerFindingToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerFindingToolInput): ToolExecution {
    return {
      description: `Filing tower ${args.type} finding: ${args.title}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const rel = await store.fileFinding(caller, {
            type: args.type,
            title: args.title,
            severity: args.severity,
            summary: args.summary,
            location: args.location,
            details: args.details,
            suggestedFix: args.suggested_fix,
          });
          return {
            output: `finding filed: ${rel}\nThe tower will route it — do not fix out-of-scope issues yourself.`,
          };
        }),
    };
  }
}

