import { collection } from '#/_base/di/collection';

/**
 * A contributor of extra environment variables for command subprocesses the agent
 * spawns (e.g. via the Bash tool). Features provide one into the agent scope; the
 * spawner merges every contributor's overlay on top of its base env. Returning
 * `undefined` means "no change" — with no contributors the base env is untouched.
 */
export interface AgentSubprocessEnvContributor {
  overlay(): Record<string, string> | undefined;
}

export const AgentSubprocessEnvContributions =
  collection<AgentSubprocessEnvContributor>('agent-subprocess-env');
