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
          const limit = args.limit ?? DEFAULT_LIMIT;
          const items =
            args.include_read === true
              ? await store.readInbox(caller, limit)
              : await store.readUnreadInbox(caller, limit);
          if (items.length === 0) {
            return { output: `inbox empty for ${caller}; 0 unread message(s) remaining` };
          }
          const remaining = await store.ackInbox(
            caller,
            items.map((item) => item.messageId),
          );
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
              '',
              `${String(remaining)} unread message(s) remaining`,
            ].join('\n'),
          };
        }),
    };
  }
}

