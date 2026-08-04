/**
 * TowerMissionTool — read or update one mission file. Called with only an
 * id it returns the rendered mission view; with patch fields it applies them
 * through the store (workers may only patch their own mission; ownership
 * assignment stays with the tower).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Agent } from '#/agent';
import { z } from 'zod';

import { MISSIONS_DIR, missionFileName } from '../../../agent/tower';
import type { TowerMission, TowerStore } from '../../../agent/tower';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runTowerTool } from './support';

export const TowerMissionToolInputSchema = z
  .object({
    id: z.string().describe('Mission id (e.g. "M1")'),
    status: z
      .enum(['planned', 'active', 'completed', 'blocked', 'paused', 'merged'])
      .optional()
      .describe('New lifecycle status'),
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

export class TowerMissionTool implements BuiltinTool<TowerMissionToolInput> {
  readonly name = 'TowerMission' as const;
  readonly description: string = `Read or update a tower mission.

With only an id, returns the mission view (status, tasks, blockers, notes). With patch fields, applies them: workers may only update the mission they own — the store rejects anything else. Use task_done to tick checklist items, note to log decisions, blocker when stuck (the tower watches for blocked missions).`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerMissionToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerMissionToolInput): ToolExecution {
    const hasPatch =
      args.status !== undefined ||
      args.note !== undefined ||
      args.blocker !== undefined ||
      args.clear_blockers !== undefined ||
      args.task_done !== undefined ||
      args.scope !== undefined;
    return {
      description: hasPatch
        ? `Updating tower mission ${args.id}`
        : `Reading tower mission ${args.id}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);
          if (!hasPatch) {
            const mission = state.missions.find((m) => m.id === args.id);
            if (mission === undefined) {
              const known = state.missions.map((m) => m.id).join(', ');
              return {
                output: `unknown mission "${args.id}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
                isError: true,
              };
            }
            return { output: await renderMission(store, mission) };
          }
          const mission = await store.updateMission(caller, args.id, {
            status: args.status,
            note: args.note,
            blocker: args.blocker,
            clearBlockers: args.clear_blockers,
            taskDone: args.task_done,
            scope: args.scope,
          });
          return {
            output: [
              `mission ${mission.id} updated — status: ${mission.status}, open tasks: ${String(mission.tasks.filter((t) => !t.done).length)}, blockers: ${String(mission.blockers.length)}`,
              '',
              await renderMission(store, mission),
            ].join('\n'),
          };
        }),
    };
  }
}

async function renderMission(store: TowerStore, mission: TowerMission): Promise<string> {
  return readFile(
    store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))),
    'utf8',
  );
}
