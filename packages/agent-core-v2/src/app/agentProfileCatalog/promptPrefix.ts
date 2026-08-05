/**
 * `agentProfileCatalog` domain — profile prompt-prefix helper.
 *
 * Applies a profile's optional per-invocation `promptPrefix` (e.g. `explore`'s
 * `<git-context>` block) to a caller-supplied prompt. Best-effort: a thrown
 * error or empty prefix leaves the prompt unchanged.
 */

import type {
  AgentProfile,
  AgentProfilePromptPrefixContext,
} from './agentProfileCatalog';

export async function applyProfilePromptPrefix(
  profile: AgentProfile,
  prompt: string,
  ctx: AgentProfilePromptPrefixContext,
): Promise<string> {
  if (profile.promptPrefix === undefined) return prompt;
  try {
    const prefix = await profile.promptPrefix(ctx);
    return prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt;
  } catch {
    return prompt;
  }
}
