import { z } from 'zod';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import { TowerProtocolError } from '../protocol/index';

import DESCRIPTION from './teardown.md?raw';
import {
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  TOWER_MAIN_AGENT_ONLY,
  type TowerToolDeps,
} from './support';

export const TowerTeardownToolInputSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe('Remove worktrees even when they contain uncommitted changes'),
  })
  .strict();

export type TowerTeardownToolInput = z.infer<typeof TowerTeardownToolInputSchema>;

export function createTowerTeardownTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerTeardown',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerTeardownToolInputSchema),
    execute({ toolCall }) {
      if (deps.agentId !== MAIN_AGENT_ID) {
        return Promise.resolve(errorText(TOWER_MAIN_AGENT_ONLY));
      }
      const parsed = parseTowerArgs(
        TowerTeardownToolInputSchema,
        toolCall.arguments,
        'TowerTeardown',
      );
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const priorOwner = await store.load().then(
          (state) => state.sessionId,
          () => undefined,
        );
        if (
          priorOwner !== undefined &&
          priorOwner !== deps.sessionId &&
          deps.isSessionLive(priorOwner)
        ) {
          throw new TowerProtocolError(
            `tower workspace is owned by a live session (${priorOwner}) — tearing it down would dismantle that session's fleet. Use TowerTeardown from that session, or close it first.`,
          );
        }
        const report = await store.teardown({ force: args.force });
        return text(
          [
            'tower teardown:',
            ...report.map((line) => `- ${line}`),
            '',
            'Tower mode stays active — the next objective starts with TowerInit, and the human can turn the mode off with /tower off. .tower/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.',
          ].join('\n'),
        );
      });
    },
  };
}
