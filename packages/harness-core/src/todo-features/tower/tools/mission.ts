import { join } from 'pathe';
import { z } from 'zod';

import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import {
  MISSIONS_DIR,
  missionFileName,
  type TowerMission,
  type TowerStore,
} from '../protocol/index';

import DESCRIPTION from './mission.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

export const TowerMissionToolInputSchema = z
  .object({
    id: z.string().describe('Mission id (e.g. "M1")'),
    status: z
      .enum(['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned'])
      .optional()
      .describe(
        'New lifecycle status. "abandoned" is tower-only: it gives the mission up without merging — releasing its scope, satisfying its dependents, and excluding its branch from conflict checks.',
      ),
    note: z.string().optional().describe('Append a decision-log note'),
    blocker: z.string().optional().describe('Report a blocker (also sets status to blocked)'),
    clear_blockers: z.boolean().optional().describe('Clear all recorded blockers'),
    task_done: z
      .string()
      .optional()
      .describe('Mark the first open task containing this text as done'),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        'Tower only: replace the mission scope globs (picomatch — `**` crosses directories). Logged; widens what the merge gate accepts.',
      ),
  })
  .strict();

export type TowerMissionToolInput = z.infer<typeof TowerMissionToolInputSchema>;

export function createTowerMissionTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerMission',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerMissionToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerMissionToolInputSchema, toolCall.arguments, 'TowerMission');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      const hasPatch =
        args.status !== undefined ||
        args.note !== undefined ||
        args.blocker !== undefined ||
        args.clear_blockers !== undefined ||
        args.task_done !== undefined ||
        args.scope !== undefined;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);
        if (!hasPatch) {
          const mission = state.missions.find((m) => m.id === args.id);
          if (mission === undefined) {
            const known = state.missions.map((m) => m.id).join(', ');
            return errorText(
              `unknown mission "${args.id}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
            );
          }
          return text(await renderMission(deps, store, mission));
        }
        const mission = await store.updateMission(caller, args.id, {
          status: args.status,
          note: args.note,
          blocker: args.blocker,
          clearBlockers: args.clear_blockers,
          taskDone: args.task_done,
          scope: args.scope,
        });
        return text(
          [
            `mission ${mission.id} updated — status: ${mission.status}, open tasks: ${String(mission.tasks.filter((t) => !t.done).length)}, blockers: ${String(mission.blockers.length)}`,
            '',
            await renderMission(deps, store, mission),
          ].join('\n'),
        );
      });
    },
  };
}

async function renderMission(
  deps: TowerToolDeps,
  store: TowerStore,
  mission: TowerMission,
): Promise<string> {
  return deps.io.fs.readText(
    store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))),
  );
}
