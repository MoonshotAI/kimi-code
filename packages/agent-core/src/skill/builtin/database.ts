import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import DATABASE_BODY from './database/SKILL.md?raw';
import DATABASE_DATA_ANALYST_BODY from './database/data-analyst/SKILL.md?raw';
import DATABASE_DATABASE_OPTIMIZER_BODY from './database/database-optimizer/SKILL.md?raw';
import DATABASE_DATABASE_OPTIMIZER_REFERENCES_INDEX_STRATEGIES from './database/database-optimizer/references/index-strategies.md?raw';
import DATABASE_DATABASE_OPTIMIZER_REFERENCES_MONITORING_ANALYSIS from './database/database-optimizer/references/monitoring-analysis.md?raw';
import DATABASE_DATABASE_OPTIMIZER_REFERENCES_MYSQL_TUNING from './database/database-optimizer/references/mysql-tuning.md?raw';
import DATABASE_DATABASE_OPTIMIZER_REFERENCES_POSTGRESQL_TUNING from './database/database-optimizer/references/postgresql-tuning.md?raw';
import DATABASE_DATABASE_OPTIMIZER_REFERENCES_QUERY_OPTIMIZATION from './database/database-optimizer/references/query-optimization.md?raw';
import DATABASE_PANDAS_PRO_BODY from './database/pandas-pro/SKILL.md?raw';
import DATABASE_PANDAS_PRO_REFERENCES_AGGREGATION_GROUPBY from './database/pandas-pro/references/aggregation-groupby.md?raw';
import DATABASE_PANDAS_PRO_REFERENCES_DATA_CLEANING from './database/pandas-pro/references/data-cleaning.md?raw';
import DATABASE_PANDAS_PRO_REFERENCES_DATAFRAME_OPERATIONS from './database/pandas-pro/references/dataframe-operations.md?raw';
import DATABASE_PANDAS_PRO_REFERENCES_MERGING_JOINING from './database/pandas-pro/references/merging-joining.md?raw';
import DATABASE_PANDAS_PRO_REFERENCES_PERFORMANCE_OPTIMIZATION from './database/pandas-pro/references/performance-optimization.md?raw';
import DATABASE_POSTGRES_PRO_BODY from './database/postgres-pro/SKILL.md?raw';
import DATABASE_POSTGRES_PRO_REFERENCES_EXTENSIONS from './database/postgres-pro/references/extensions.md?raw';
import DATABASE_POSTGRES_PRO_REFERENCES_JSONB from './database/postgres-pro/references/jsonb.md?raw';
import DATABASE_POSTGRES_PRO_REFERENCES_MAINTENANCE from './database/postgres-pro/references/maintenance.md?raw';
import DATABASE_POSTGRES_PRO_REFERENCES_PERFORMANCE from './database/postgres-pro/references/performance.md?raw';
import DATABASE_POSTGRES_PRO_REFERENCES_REPLICATION from './database/postgres-pro/references/replication.md?raw';
import DATABASE_SPARK_ENGINEER_BODY from './database/spark-engineer/SKILL.md?raw';
import DATABASE_SPARK_ENGINEER_REFERENCES_PARTITIONING_CACHING from './database/spark-engineer/references/partitioning-caching.md?raw';
import DATABASE_SPARK_ENGINEER_REFERENCES_PERFORMANCE_TUNING from './database/spark-engineer/references/performance-tuning.md?raw';
import DATABASE_SPARK_ENGINEER_REFERENCES_RDD_OPERATIONS from './database/spark-engineer/references/rdd-operations.md?raw';
import DATABASE_SPARK_ENGINEER_REFERENCES_SPARK_SQL_DATAFRAMES from './database/spark-engineer/references/spark-sql-dataframes.md?raw';
import DATABASE_SPARK_ENGINEER_REFERENCES_STREAMING_PATTERNS from './database/spark-engineer/references/streaming-patterns.md?raw';
import DATABASE_SQL_PRO_BODY from './database/sql-pro/SKILL.md?raw';
import DATABASE_SQL_PRO_REFERENCES_DATABASE_DESIGN from './database/sql-pro/references/database-design.md?raw';
import DATABASE_SQL_PRO_REFERENCES_DIALECT_DIFFERENCES from './database/sql-pro/references/dialect-differences.md?raw';
import DATABASE_SQL_PRO_REFERENCES_OPTIMIZATION from './database/sql-pro/references/optimization.md?raw';
import DATABASE_SQL_PRO_REFERENCES_QUERY_PATTERNS from './database/sql-pro/references/query-patterns.md?raw';
import DATABASE_SQL_PRO_REFERENCES_WINDOW_FUNCTIONS from './database/sql-pro/references/window-functions.md?raw';

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
  {
    'references/index-strategies.md': DATABASE_DATABASE_OPTIMIZER_REFERENCES_INDEX_STRATEGIES,
    'references/monitoring-analysis.md': DATABASE_DATABASE_OPTIMIZER_REFERENCES_MONITORING_ANALYSIS,
    'references/mysql-tuning.md': DATABASE_DATABASE_OPTIMIZER_REFERENCES_MYSQL_TUNING,
    'references/postgresql-tuning.md': DATABASE_DATABASE_OPTIMIZER_REFERENCES_POSTGRESQL_TUNING,
    'references/query-optimization.md': DATABASE_DATABASE_OPTIMIZER_REFERENCES_QUERY_OPTIMIZATION,
  },
);

export const DATABASE_PANDAS_PRO_SKILL = makeBuiltin(
  DATABASE_PANDAS_PRO_BODY,
  'database.pandas-pro',
  'builtin://database/pandas-pro',
  { isSubSkill: true },
  {
    'references/aggregation-groupby.md': DATABASE_PANDAS_PRO_REFERENCES_AGGREGATION_GROUPBY,
    'references/data-cleaning.md': DATABASE_PANDAS_PRO_REFERENCES_DATA_CLEANING,
    'references/dataframe-operations.md': DATABASE_PANDAS_PRO_REFERENCES_DATAFRAME_OPERATIONS,
    'references/merging-joining.md': DATABASE_PANDAS_PRO_REFERENCES_MERGING_JOINING,
    'references/performance-optimization.md': DATABASE_PANDAS_PRO_REFERENCES_PERFORMANCE_OPTIMIZATION,
  },
);

export const DATABASE_POSTGRES_PRO_SKILL = makeBuiltin(
  DATABASE_POSTGRES_PRO_BODY,
  'database.postgres-pro',
  'builtin://database/postgres-pro',
  { isSubSkill: true },
  {
    'references/extensions.md': DATABASE_POSTGRES_PRO_REFERENCES_EXTENSIONS,
    'references/jsonb.md': DATABASE_POSTGRES_PRO_REFERENCES_JSONB,
    'references/maintenance.md': DATABASE_POSTGRES_PRO_REFERENCES_MAINTENANCE,
    'references/performance.md': DATABASE_POSTGRES_PRO_REFERENCES_PERFORMANCE,
    'references/replication.md': DATABASE_POSTGRES_PRO_REFERENCES_REPLICATION,
  },
);

export const DATABASE_SPARK_ENGINEER_SKILL = makeBuiltin(
  DATABASE_SPARK_ENGINEER_BODY,
  'database.spark-engineer',
  'builtin://database/spark-engineer',
  { isSubSkill: true },
  {
    'references/partitioning-caching.md': DATABASE_SPARK_ENGINEER_REFERENCES_PARTITIONING_CACHING,
    'references/performance-tuning.md': DATABASE_SPARK_ENGINEER_REFERENCES_PERFORMANCE_TUNING,
    'references/rdd-operations.md': DATABASE_SPARK_ENGINEER_REFERENCES_RDD_OPERATIONS,
    'references/spark-sql-dataframes.md': DATABASE_SPARK_ENGINEER_REFERENCES_SPARK_SQL_DATAFRAMES,
    'references/streaming-patterns.md': DATABASE_SPARK_ENGINEER_REFERENCES_STREAMING_PATTERNS,
  },
);

export const DATABASE_SQL_PRO_SKILL = makeBuiltin(
  DATABASE_SQL_PRO_BODY,
  'database.sql-pro',
  'builtin://database/sql-pro',
  { isSubSkill: true },
  {
    'references/database-design.md': DATABASE_SQL_PRO_REFERENCES_DATABASE_DESIGN,
    'references/dialect-differences.md': DATABASE_SQL_PRO_REFERENCES_DIALECT_DIFFERENCES,
    'references/optimization.md': DATABASE_SQL_PRO_REFERENCES_OPTIMIZATION,
    'references/query-patterns.md': DATABASE_SQL_PRO_REFERENCES_QUERY_PATTERNS,
    'references/window-functions.md': DATABASE_SQL_PRO_REFERENCES_WINDOW_FUNCTIONS,
  },
);
