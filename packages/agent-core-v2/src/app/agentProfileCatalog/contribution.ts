import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileInput,
} from './agentProfileCatalog';

const _profileContributions: AgentProfile[] = [];

export function registerAgentProfile(definition: AgentProfileInput): void {
  const profile = normalizeAgentProfile(definition);
  const existingIndex = _profileContributions.findIndex((d) => d.name === profile.name);
  if (existingIndex >= 0) {
    _profileContributions.splice(existingIndex, 1);
  }
  _profileContributions.push(profile);
}

export function getAgentProfileContributions(): readonly AgentProfile[] {
  return _profileContributions;
}

export function _clearAgentProfileContributionsForTests(): void {
  _profileContributions.length = 0;
}
