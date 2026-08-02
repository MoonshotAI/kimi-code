/** Agent profile subsystem — local port of the retired `agent-core/profile`. */
export { prepareSystemPromptContext, loadAgentsMd } from './context';
export type { PreparedSystemPromptContext, PrepareSystemPromptContextOptions } from './context';
export { DEFAULT_AGENT_PROFILES, DEFAULT_INIT_PROMPT } from './default';
export { loadAgentProfilesFromSources, loadAgentProfilesFromDir } from './load';
export type {
  RawAgentProfile,
  RawSubagentProfile,
  ResolvedAgentProfile,
  SystemPromptContext,
  SystemPromptRenderer,
  SkillRegistry,
} from './types';
