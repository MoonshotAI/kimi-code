/**
 * `skillCatalog` domain (L3) — builtin `game-developer` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import GAME_DEVELOPER_BODY from './game-developer/SKILL.md?raw';
import GAME_DEVELOPER_REFERENCES_ECS_PATTERNS from './game-developer/references/ecs-patterns.md?raw';
import GAME_DEVELOPER_REFERENCES_MULTIPLAYER_NETWORKING from './game-developer/references/multiplayer-networking.md?raw';
import GAME_DEVELOPER_REFERENCES_PERFORMANCE_OPTIMIZATION from './game-developer/references/performance-optimization.md?raw';
import GAME_DEVELOPER_REFERENCES_UNITY_PATTERNS from './game-developer/references/unity-patterns.md?raw';
import GAME_DEVELOPER_REFERENCES_UNREAL_CPP from './game-developer/references/unreal-cpp.md?raw';

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

export const GAME_DEVELOPER_SKILL = makeBuiltin(
  GAME_DEVELOPER_BODY,
  'game-developer',
  'builtin://game-developer',
  {},
  {
    'references/ecs-patterns.md': GAME_DEVELOPER_REFERENCES_ECS_PATTERNS,
    'references/multiplayer-networking.md': GAME_DEVELOPER_REFERENCES_MULTIPLAYER_NETWORKING,
    'references/performance-optimization.md': GAME_DEVELOPER_REFERENCES_PERFORMANCE_OPTIMIZATION,
    'references/unity-patterns.md': GAME_DEVELOPER_REFERENCES_UNITY_PATTERNS,
    'references/unreal-cpp.md': GAME_DEVELOPER_REFERENCES_UNREAL_CPP,
  },
);

