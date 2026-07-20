import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import DEBUGGING_BODY from './debugging/SKILL.md?raw';
import DEBUGGING_DEBUGGER_BODY from './debugging/debugger/SKILL.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_BODY from './debugging/debugging-wizard/SKILL.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_REFERENCES_COMMON_PATTERNS from './debugging/debugging-wizard/references/common-patterns.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_REFERENCES_DEBUGGING_TOOLS from './debugging/debugging-wizard/references/debugging-tools.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_REFERENCES_QUICK_FIXES from './debugging/debugging-wizard/references/quick-fixes.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_REFERENCES_STRATEGIES from './debugging/debugging-wizard/references/strategies.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_REFERENCES_SYSTEMATIC_DEBUGGING from './debugging/debugging-wizard/references/systematic-debugging.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
  resources?: Readonly<Record<string, string>>,
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}/SKILL.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name: dirName,
    path: pseudoPath,
    dir: pseudoPath,
    resources,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const DEBUGGING_SKILL = makeBuiltin(
  DEBUGGING_BODY,
  'debugging',
  'builtin://debugging',
  { 'has-sub-skill': true },
);

export const DEBUGGING_DEBUGGER_SKILL = makeBuiltin(
  DEBUGGING_DEBUGGER_BODY,
  'debugging.debugger',
  'builtin://debugging/debugger',
  { isSubSkill: true },
);

export const DEBUGGING_DEBUGGING_WIZARD_SKILL = makeBuiltin(
  DEBUGGING_DEBUGGING_WIZARD_BODY,
  'debugging.debugging-wizard',
  'builtin://debugging/debugging-wizard',
  { isSubSkill: true },
  {
    'references/common-patterns.md': DEBUGGING_DEBUGGING_WIZARD_REFERENCES_COMMON_PATTERNS,
    'references/debugging-tools.md': DEBUGGING_DEBUGGING_WIZARD_REFERENCES_DEBUGGING_TOOLS,
    'references/quick-fixes.md': DEBUGGING_DEBUGGING_WIZARD_REFERENCES_QUICK_FIXES,
    'references/strategies.md': DEBUGGING_DEBUGGING_WIZARD_REFERENCES_STRATEGIES,
    'references/systematic-debugging.md': DEBUGGING_DEBUGGING_WIZARD_REFERENCES_SYSTEMATIC_DEBUGGING,
  },
);

