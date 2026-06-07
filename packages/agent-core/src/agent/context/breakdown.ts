import type { Tool } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { isMcpToolName } from '../../mcp/tool-naming';
import { loadAgentsMd } from '../../profile/context';
import { AGENT_TOOL_NAME } from '../../tools/builtin/collaboration/agent';
import { estimateTokens, estimateTokensForMessages, estimateTokensForTools } from '../../utils/tokens';

export type ContextCategoryKey =
  | 'systemPrompt'
  | 'systemTools'
  | 'mcpTools'
  | 'customAgents'
  | 'memoryFiles'
  | 'skills'
  | 'messages'
  | 'freeSpace';

export interface ContextCategory {
  readonly key: ContextCategoryKey;
  readonly label: string;
  /** Estimated tokens this category contributes. Floored at 0. */
  readonly tokens: number;
}

/**
 * Estimated breakdown of what fills the model's context window, by category.
 * All counts are character-based estimates (see {@link estimateTokens}); the
 * total is intentionally estimate-based so the categories are mutually
 * exclusive and sum to `totalTokens`.
 */
export interface ContextBreakdown {
  readonly model: string;
  /** Model context window in tokens, or 0 when unknown. */
  readonly maxContextTokens: number;
  /** Sum of every non-free category. */
  readonly totalTokens: number;
  readonly categories: readonly ContextCategory[];
}

/**
 * Compute a per-category estimate of the agent's current context usage.
 *
 * The rendered system prompt already embeds the skills listing and memory
 * (AGENTS.md), so those are estimated independently and subtracted from the
 * system-prompt total to keep categories from double-counting.
 */
export async function computeContextBreakdown(agent: Agent): Promise<ContextBreakdown> {
  const config = agent.config;
  const maxContextTokens = config.modelCapabilities.max_context_tokens ?? 0;
  const model = config.modelAlias ?? '';

  const skillsTokens = estimateTokens(agent.skills?.registry.getModelSkillListing() ?? '');
  const memoryTokens = estimateTokens(await loadAgentsMd(agent.kaos));
  const systemPromptFull = estimateTokens(config.systemPrompt);
  const systemPromptTokens = Math.max(0, systemPromptFull - skillsTokens - memoryTokens);

  // Classify each always-sent tool, then count each group with the same
  // estimator the status baseline uses so the two can't drift. The subagent
  // tool's schema lists the available agent types — the only always-sent
  // representation of custom agents — so it gets its own bucket.
  const systemTools: Tool[] = [];
  const mcpTools: Tool[] = [];
  const agentTools: Tool[] = [];
  for (const tool of agent.tools.loopTools) {
    if (isMcpToolName(tool.name)) {
      mcpTools.push(tool);
    } else if (tool.name === AGENT_TOOL_NAME) {
      agentTools.push(tool);
    } else {
      systemTools.push(tool);
    }
  }
  const systemToolsTokens = estimateTokensForTools(systemTools);
  const mcpToolsTokens = estimateTokensForTools(mcpTools);
  const customAgentsTokens = estimateTokensForTools(agentTools);

  const fixedTokens =
    systemPromptTokens +
    systemToolsTokens +
    mcpToolsTokens +
    customAgentsTokens +
    memoryTokens +
    skillsTokens;

  // Anchor the conversation bucket to the real provider input count once a turn
  // has reported usage, so the breakdown total (and its percentage) matches the
  // status-bar indicator instead of drifting by character-estimate error.
  // Before the first turn — or if the fixed estimate already overshoots the real
  // count — fall back to a pure message estimate so the baseline still shows.
  const realTokens = agent.context.tokenCount;
  const messagesTokens =
    realTokens > fixedTokens
      ? realTokens - fixedTokens
      : estimateTokensForMessages(agent.context.messages);

  const totalTokens = fixedTokens + messagesTokens;

  const freeSpace = maxContextTokens > 0 ? Math.max(0, maxContextTokens - totalTokens) : 0;

  const categories: readonly ContextCategory[] = [
    { key: 'systemPrompt', label: 'System prompt', tokens: systemPromptTokens },
    { key: 'systemTools', label: 'System tools', tokens: systemToolsTokens },
    { key: 'mcpTools', label: 'MCP tools', tokens: mcpToolsTokens },
    { key: 'customAgents', label: 'Custom agents', tokens: customAgentsTokens },
    { key: 'memoryFiles', label: 'Memory files', tokens: memoryTokens },
    { key: 'skills', label: 'Skills', tokens: skillsTokens },
    { key: 'messages', label: 'Messages', tokens: messagesTokens },
    { key: 'freeSpace', label: 'Free space', tokens: freeSpace },
  ];

  return { model, maxContextTokens, totalTokens, categories };
}
