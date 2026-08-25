import type { SkillDefinition } from '#/features/skill/catalog/types';
import { parseSkillText } from '#/features/skill/catalog/parser';
import { registerBuiltinSkill } from '#/features/skill/catalog/builtin/registry';

import { FLOW_FLAG_ID } from '../flow';

import FLOW_CONTRACT from './contract.md?raw';
import FLOW_DRAFT_BODY from './draft.md?raw';

/** The shared supervisor contract — the body every projected per-flow skill
 *  (see flowsSkillSource) is assembled from. */
export const FLOW_SUPERVISOR_CONTRACT: string = FLOW_CONTRACT.trim();

const DRAFT_PSEUDO_PATH = 'builtin://flow';

const parsedDraft = parseSkillText({
  skillMdPath: '/builtin/skills/flow.md',
  skillDirName: 'flow',
  source: 'builtin',
  text: FLOW_DRAFT_BODY.replace('$CONTRACT', () => FLOW_SUPERVISOR_CONTRACT),
});

/**
 * The built-in `/flow` drafting skill: turns a raw task into a flow
 * definition with the user, then starts the run via FlowStart (which raises
 * its own start-review approval). Registered through the builtin channel —
 * the lowest-priority skill source — so a user or project skill named `flow`
 * still wins, and the `experimentalFlag` keeps it invisible while the flow
 * flag is off.
 */
export const FLOW_DRAFT_SKILL: SkillDefinition = {
  ...parsedDraft,
  path: DRAFT_PSEUDO_PATH,
  dir: DRAFT_PSEUDO_PATH,
  experimentalFlag: FLOW_FLAG_ID,
  metadata: {
    ...parsedDraft.metadata,
    type: parsedDraft.metadata.type ?? 'inline',
  },
};

registerBuiltinSkill(FLOW_DRAFT_SKILL);
