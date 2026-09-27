import type { LlmModel } from '@moonshot-ai/agent-core';

import CODER_ROLE from './coder-role.md?raw';
import EXPLORE_ROLE from './explore-role.md?raw';

export interface SpawnProfileContext {
  readonly callerAgentId: string;
}

export interface SpawnProfile {
  readonly name: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly systemPrompt: (context: SpawnProfileContext) => string;
  readonly promptPrefix?: (context: SpawnProfileContext) => string | Promise<string>;
  readonly subagents?: readonly string[];
}

export interface SpawnModelEntry {
  readonly name: string;
  readonly description?: string;
  readonly model: LlmModel;
}

export interface SpawnProfileCatalog {
  list(): readonly SpawnProfile[];
  get(name: string): SpawnProfile | undefined;
}

export function createStaticCatalog(profiles: readonly SpawnProfile[]): SpawnProfileCatalog {
  return {
    list: () => profiles,
    get: (name) => profiles.find((profile) => profile.name === name),
  };
}

const CODER_TOOLS = [
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'ReadMediaFile',
  'Skill',
  'TodoList',
  'WaitFor',
  'WebSearch',
  'FetchURL',
  'Write',
  'mcp__*',
] as const;

const EXPLORE_TOOLS = [
  'Bash',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

export const builtinSpawnCatalog: SpawnProfileCatalog = createStaticCatalog([
  {
    name: 'coder',
    description:
      'General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code.',
    tools: CODER_TOOLS,
    systemPrompt: () => CODER_ROLE.trim(),
  },
  {
    name: 'explore',
    description:
      'Fast codebase exploration with prompt-enforced read-only behavior.',
    tools: EXPLORE_TOOLS,
    systemPrompt: () => EXPLORE_ROLE.trim(),
  },
]);
