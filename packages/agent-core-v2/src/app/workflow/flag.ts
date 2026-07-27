/**
 * `workflow` domain (L6) — registers the `dynamic-workflows` experimental flag
 * into `flag`.
 *
 * Gates every Dynamic Workflows surface: the `Workflow` agent tool, the
 * unconditional approval review, and (through the tool) workflow runs. Off by
 * default; enable via `KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect from the package barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const DYNAMIC_WORKFLOWS_FLAG_ID = 'dynamic-workflows';
export const DYNAMIC_WORKFLOWS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS';

export const dynamicWorkflowsFlag: FlagDefinitionInput = {
  id: DYNAMIC_WORKFLOWS_FLAG_ID,
  title: 'Dynamic workflows',
  description:
    'User-approved JS workflow scripts that orchestrate subagents in phases with parallel fan-out, pipelines, and JSON-schema structured output.',
  env: DYNAMIC_WORKFLOWS_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(dynamicWorkflowsFlag);
