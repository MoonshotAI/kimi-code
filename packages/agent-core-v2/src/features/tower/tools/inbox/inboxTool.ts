/**
 * `tools` domain — `TowerInboxTool` implementation (the `TowerInbox` tool).
 *
 * Reads the inbox through the protocol `TowerStore` rooted at the session
 * cwd (`sessionContext`), resolving the caller's roster identity from the
 * agent scope (`scopeContext`). Registered for every agent — visibility is
 * controlled by profile tool lists. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './inbox.md?raw';
import { ITowerInboxTool, TowerInboxToolInputSchema, type TowerInboxToolInput } from './inbox';

const DEFAULT_LIMIT = 20;

export class TowerInboxTool implements ITowerInboxTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerInbox' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerInboxToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerInboxToolInput): ToolExecution {
    return {
      description: 'Reading tower inbox',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const items = await store.readInbox(caller, args.limit ?? DEFAULT_LIMIT);
          if (items.length === 0) {
            return { output: `inbox empty for ${caller}` };
          }
          const sections = items.map((item) =>
            [
              `file: ${item.file}`,
              `from: ${item.from}`,
              `to: ${item.to}`,
              `subject: ${item.subject}`,
              `sent_at: ${item.sentAt}`,
              ...(item.scope !== undefined ? [`scope: ${item.scope}`] : []),
              ...(item.action !== undefined ? [`action: ${item.action}`] : []),
              '',
              item.body,
            ].join('\n'),
          );
          return {
            output: [
              `${String(items.length)} message(s) for ${caller} (newest first):`,
              '',
              sections.join('\n\n---\n\n'),
            ].join('\n'),
          };
        }),
    };
  }
}

