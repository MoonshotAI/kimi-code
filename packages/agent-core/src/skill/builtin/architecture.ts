import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import ARCHITECTURE_BODY from './architecture/SKILL.md?raw';
import ARCHITECTURE_API_DESIGNER_BODY from './architecture/api-designer/SKILL.md?raw';
import ARCHITECTURE_API_DESIGNER_REFERENCES_ERROR_HANDLING from './architecture/api-designer/references/error-handling.md?raw';
import ARCHITECTURE_API_DESIGNER_REFERENCES_OPENAPI from './architecture/api-designer/references/openapi.md?raw';
import ARCHITECTURE_API_DESIGNER_REFERENCES_PAGINATION from './architecture/api-designer/references/pagination.md?raw';
import ARCHITECTURE_API_DESIGNER_REFERENCES_REST_PATTERNS from './architecture/api-designer/references/rest-patterns.md?raw';
import ARCHITECTURE_API_DESIGNER_REFERENCES_VERSIONING from './architecture/api-designer/references/versioning.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_BODY from './architecture/architecture-designer/SKILL.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_ADR_TEMPLATE from './architecture/architecture-designer/references/adr-template.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_ARCHITECTURE_PATTERNS from './architecture/architecture-designer/references/architecture-patterns.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_DATABASE_SELECTION from './architecture/architecture-designer/references/database-selection.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_NFR_CHECKLIST from './architecture/architecture-designer/references/nfr-checklist.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_SYSTEM_DESIGN from './architecture/architecture-designer/references/system-design.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_BODY from './architecture/graphql-architect/SKILL.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_FEDERATION from './architecture/graphql-architect/references/federation.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_MIGRATION_FROM_REST from './architecture/graphql-architect/references/migration-from-rest.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_RESOLVERS from './architecture/graphql-architect/references/resolvers.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SCHEMA_DESIGN from './architecture/graphql-architect/references/schema-design.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SECURITY from './architecture/graphql-architect/references/security.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SUBSCRIPTIONS from './architecture/graphql-architect/references/subscriptions.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_BODY from './architecture/legacy-modernizer/SKILL.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_LEGACY_TESTING from './architecture/legacy-modernizer/references/legacy-testing.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_MIGRATION_STRATEGIES from './architecture/legacy-modernizer/references/migration-strategies.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_REFACTORING_PATTERNS from './architecture/legacy-modernizer/references/refactoring-patterns.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_STRANGLER_FIG_PATTERN from './architecture/legacy-modernizer/references/strangler-fig-pattern.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_SYSTEM_ASSESSMENT from './architecture/legacy-modernizer/references/system-assessment.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_BODY from './architecture/microservices-architect/SKILL.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_COMMUNICATION from './architecture/microservices-architect/references/communication.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_DATA from './architecture/microservices-architect/references/data.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_DECOMPOSITION from './architecture/microservices-architect/references/decomposition.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_OBSERVABILITY from './architecture/microservices-architect/references/observability.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_PATTERNS from './architecture/microservices-architect/references/patterns.md?raw';
import ARCHITECTURE_SPEC_MINER_BODY from './architecture/spec-miner/SKILL.md?raw';
import ARCHITECTURE_SPEC_MINER_REFERENCES_ANALYSIS_CHECKLIST from './architecture/spec-miner/references/analysis-checklist.md?raw';
import ARCHITECTURE_SPEC_MINER_REFERENCES_ANALYSIS_PROCESS from './architecture/spec-miner/references/analysis-process.md?raw';
import ARCHITECTURE_SPEC_MINER_REFERENCES_EARS_FORMAT from './architecture/spec-miner/references/ears-format.md?raw';
import ARCHITECTURE_SPEC_MINER_REFERENCES_SPECIFICATION_TEMPLATE from './architecture/spec-miner/references/specification-template.md?raw';

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

export const ARCHITECTURE_SKILL = makeBuiltin(
  ARCHITECTURE_BODY,
  'architecture',
  'builtin://architecture',
  { 'has-sub-skill': true },
);

export const ARCHITECTURE_API_DESIGNER_SKILL = makeBuiltin(
  ARCHITECTURE_API_DESIGNER_BODY,
  'architecture.api-designer',
  'builtin://architecture/api-designer',
  { isSubSkill: true },
  {
    'references/error-handling.md': ARCHITECTURE_API_DESIGNER_REFERENCES_ERROR_HANDLING,
    'references/openapi.md': ARCHITECTURE_API_DESIGNER_REFERENCES_OPENAPI,
    'references/pagination.md': ARCHITECTURE_API_DESIGNER_REFERENCES_PAGINATION,
    'references/rest-patterns.md': ARCHITECTURE_API_DESIGNER_REFERENCES_REST_PATTERNS,
    'references/versioning.md': ARCHITECTURE_API_DESIGNER_REFERENCES_VERSIONING,
  },
);

export const ARCHITECTURE_ARCHITECTURE_DESIGNER_SKILL = makeBuiltin(
  ARCHITECTURE_ARCHITECTURE_DESIGNER_BODY,
  'architecture.architecture-designer',
  'builtin://architecture/architecture-designer',
  { isSubSkill: true },
  {
    'references/adr-template.md': ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_ADR_TEMPLATE,
    'references/architecture-patterns.md': ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_ARCHITECTURE_PATTERNS,
    'references/database-selection.md': ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_DATABASE_SELECTION,
    'references/nfr-checklist.md': ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_NFR_CHECKLIST,
    'references/system-design.md': ARCHITECTURE_ARCHITECTURE_DESIGNER_REFERENCES_SYSTEM_DESIGN,
  },
);

export const ARCHITECTURE_GRAPHQL_ARCHITECT_SKILL = makeBuiltin(
  ARCHITECTURE_GRAPHQL_ARCHITECT_BODY,
  'architecture.graphql-architect',
  'builtin://architecture/graphql-architect',
  { isSubSkill: true },
  {
    'references/federation.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_FEDERATION,
    'references/migration-from-rest.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_MIGRATION_FROM_REST,
    'references/resolvers.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_RESOLVERS,
    'references/schema-design.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SCHEMA_DESIGN,
    'references/security.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SECURITY,
    'references/subscriptions.md': ARCHITECTURE_GRAPHQL_ARCHITECT_REFERENCES_SUBSCRIPTIONS,
  },
);

export const ARCHITECTURE_LEGACY_MODERNIZER_SKILL = makeBuiltin(
  ARCHITECTURE_LEGACY_MODERNIZER_BODY,
  'architecture.legacy-modernizer',
  'builtin://architecture/legacy-modernizer',
  { isSubSkill: true },
  {
    'references/legacy-testing.md': ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_LEGACY_TESTING,
    'references/migration-strategies.md': ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_MIGRATION_STRATEGIES,
    'references/refactoring-patterns.md': ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_REFACTORING_PATTERNS,
    'references/strangler-fig-pattern.md': ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_STRANGLER_FIG_PATTERN,
    'references/system-assessment.md': ARCHITECTURE_LEGACY_MODERNIZER_REFERENCES_SYSTEM_ASSESSMENT,
  },
);

export const ARCHITECTURE_MICROSERVICES_ARCHITECT_SKILL = makeBuiltin(
  ARCHITECTURE_MICROSERVICES_ARCHITECT_BODY,
  'architecture.microservices-architect',
  'builtin://architecture/microservices-architect',
  { isSubSkill: true },
  {
    'references/communication.md': ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_COMMUNICATION,
    'references/data.md': ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_DATA,
    'references/decomposition.md': ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_DECOMPOSITION,
    'references/observability.md': ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_OBSERVABILITY,
    'references/patterns.md': ARCHITECTURE_MICROSERVICES_ARCHITECT_REFERENCES_PATTERNS,
  },
);

export const ARCHITECTURE_SPEC_MINER_SKILL = makeBuiltin(
  ARCHITECTURE_SPEC_MINER_BODY,
  'architecture.spec-miner',
  'builtin://architecture/spec-miner',
  { isSubSkill: true },
  {
    'references/analysis-checklist.md': ARCHITECTURE_SPEC_MINER_REFERENCES_ANALYSIS_CHECKLIST,
    'references/analysis-process.md': ARCHITECTURE_SPEC_MINER_REFERENCES_ANALYSIS_PROCESS,
    'references/ears-format.md': ARCHITECTURE_SPEC_MINER_REFERENCES_EARS_FORMAT,
    'references/specification-template.md': ARCHITECTURE_SPEC_MINER_REFERENCES_SPECIFICATION_TEMPLATE,
  },
);

