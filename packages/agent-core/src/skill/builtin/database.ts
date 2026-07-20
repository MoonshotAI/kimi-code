import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import DATABASE_BODY from './database/SKILL.md?raw';
import DATABASE_DATA_ANALYST_BODY from './database/data-analyst/SKILL.md?raw';
import DATABASE_DATABASE_OPTIMIZER_BODY from './database/database-optimizer/SKILL.md?raw';
import DATABASE_PANDAS_PRO_BODY from './database/pandas-pro/SKILL.md?raw';
import DATABASE_POSTGRES_PRO_BODY from './database/postgres-pro/SKILL.md?raw';
import DATABASE_SPARK_ENGINEER_BODY from './database/spark-engineer/SKILL.md?raw';
import DATABASE_SQL_PRO_BODY from './database/sql-pro/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
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
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const DATABASE_SKILL = makeBuiltin(
  DATABASE_BODY,
  'database',
  'builtin://database',
  { 'has-sub-skill': true },
);

export const DATABASE_DATA_ANALYST_SKILL = makeBuiltin(
  DATABASE_DATA_ANALYST_BODY,
  'database.data-analyst',
  'builtin://database/data-analyst',
  { isSubSkill: true },
);

export const DATABASE_DATABASE_OPTIMIZER_SKILL = makeBuiltin(
  DATABASE_DATABASE_OPTIMIZER_BODY,
  'database.database-optimizer',
  'builtin://database/database-optimizer',
  { isSubSkill: true },
);

export const DATABASE_PANDAS_PRO_SKILL = makeBuiltin(
  DATABASE_PANDAS_PRO_BODY,
  'database.pandas-pro',
  'builtin://database/pandas-pro',
  { isSubSkill: true },
);

export const DATABASE_POSTGRES_PRO_SKILL = makeBuiltin(
  DATABASE_POSTGRES_PRO_BODY,
  'database.postgres-pro',
  'builtin://database/postgres-pro',
  { isSubSkill: true },
);

export const DATABASE_SPARK_ENGINEER_SKILL = makeBuiltin(
  DATABASE_SPARK_ENGINEER_BODY,
  'database.spark-engineer',
  'builtin://database/spark-engineer',
  { isSubSkill: true },
);

export const DATABASE_SQL_PRO_SKILL = makeBuiltin(
  DATABASE_SQL_PRO_BODY,
  'database.sql-pro',
  'builtin://database/sql-pro',
  { isSubSkill: true },
);

