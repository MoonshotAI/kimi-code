import agentYaml from './default/agent.yaml';
import coderYaml from './default/coder.yaml';
import exploreYaml from './default/explore.yaml';
import initMd from './default/init.md';
import planYaml from './default/plan.yaml';
import systemMd from './default/system.md';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
export const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/plan.yaml': planYaml,
  'profile/default/system.md': systemMd,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_PROFILE_PATHS = ['agent.yaml', 'coder.yaml', 'explore.yaml', 'plan.yaml'].map(
  (file) => `profile/default/${file}`,
);

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  DEFAULT_PROFILE_PATHS,
  PROFILE_SOURCES,
);
