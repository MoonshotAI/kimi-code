/**
 * `skillCatalog` domain (L3) — builtin `embedded-systems` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import EMBEDDED_SYSTEMS_BODY from './embedded-systems/SKILL.md?raw';
import EMBEDDED_SYSTEMS_REFERENCES_COMMUNICATION_PROTOCOLS from './embedded-systems/references/communication-protocols.md?raw';
import EMBEDDED_SYSTEMS_REFERENCES_MEMORY_OPTIMIZATION from './embedded-systems/references/memory-optimization.md?raw';
import EMBEDDED_SYSTEMS_REFERENCES_MICROCONTROLLER_PROGRAMMING from './embedded-systems/references/microcontroller-programming.md?raw';
import EMBEDDED_SYSTEMS_REFERENCES_POWER_OPTIMIZATION from './embedded-systems/references/power-optimization.md?raw';
import EMBEDDED_SYSTEMS_REFERENCES_RTOS_PATTERNS from './embedded-systems/references/rtos-patterns.md?raw';

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

export const EMBEDDED_SYSTEMS_SKILL = makeBuiltin(
  EMBEDDED_SYSTEMS_BODY,
  'embedded-systems',
  'builtin://embedded-systems',
  {},
  {
    'references/communication-protocols.md': EMBEDDED_SYSTEMS_REFERENCES_COMMUNICATION_PROTOCOLS,
    'references/memory-optimization.md': EMBEDDED_SYSTEMS_REFERENCES_MEMORY_OPTIMIZATION,
    'references/microcontroller-programming.md': EMBEDDED_SYSTEMS_REFERENCES_MICROCONTROLLER_PROGRAMMING,
    'references/power-optimization.md': EMBEDDED_SYSTEMS_REFERENCES_POWER_OPTIMIZATION,
    'references/rtos-patterns.md': EMBEDDED_SYSTEMS_REFERENCES_RTOS_PATTERNS,
  },
);

