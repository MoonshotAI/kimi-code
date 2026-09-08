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
