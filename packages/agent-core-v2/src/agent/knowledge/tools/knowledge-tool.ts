/**
 * `knowledge` domain (L4) — Knowledge tool registration.
 *
 * Registers the `Knowledge` tool that lets the model actively interact
 * with the knowledge base: search, add, confirm, reject entries.
 * Only available to the main agent.
 */

import { z } from 'zod';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/agentScopeContext';
import { IAgentKnowledgeService } from '../knowledge';

import TOOL_DESCRIPTION from './knowledge-tool.md?raw';

const KnowledgeInputSchema = z.object({
  action: z.enum(['search', 'add', 'confirm', 'reject']),
  query: z.string().optional(),
  scope: z.string().optional(),
  tags: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  category: z.enum(['coding-style', 'pitfall', 'architecture', 'workflow']).optional(),
  content: z.string().optional(),
});

type KnowledgeInput = z.infer<typeof KnowledgeInputSchema>;

class KnowledgeTool {
  static readonly name = 'Knowledge';
  static readonly description = TOOL_DESCRIPTION;
  static readonly inputSchema = KnowledgeInputSchema;

  readonly name = KnowledgeTool.name;

  async execute(input: KnowledgeInput, accessor: { get<T>(id: { new(...args: unknown[]): T }): T }): Promise<string> {
    const knowledge = accessor.get(IAgentKnowledgeService as unknown as { new(...args: unknown[]): IAgentKnowledgeService });

    switch (input.action) {
      case 'search': {
        const query = input.query ?? '';
        const tags = input.tags?.split(',').filter(Boolean);
        const results = knowledge.search(query, input.scope, tags);
        if (results.length === 0) return 'No matching knowledge entries found.';
        return results.map((r, i) =>
          `${i + 1}. [${r.entry.category}] ${r.entry.title} (confidence: ${r.entry.confidence})\n   ${r.entry.content.split('\n')[0]}`
        ).join('\n\n');
      }

      case 'add': {
        if (!input.title || !input.content || !input.category) {
          return 'Error: title, content, and category are required for add action.';
        }
        const entry = knowledge.add({
          title: input.title,
          category: input.category,
          content: input.content,
          tags: input.tags?.split(',').filter(Boolean),
          scope: input.scope,
          source: 'ai-learned',
          confidence: 0.7,
        });
        return entry
          ? `Learned: [${entry.category}] ${entry.title} (id: ${entry.id}, confidence: 0.7)`
          : 'Failed to add knowledge entry.';
      }

      case 'confirm': {
        if (!input.id) return 'Error: id is required for confirm action.';
        const ok = knowledge.confirm(input.id);
        return ok ? `Confirmed entry ${input.id} (confidence → 1.0)` : `Entry ${input.id} not found.`;
      }

      case 'reject': {
        if (!input.id) return 'Error: id is required for reject action.';
        const ok = knowledge.remove(input.id);
        return ok ? `Rejected and removed entry ${input.id}` : `Entry ${input.id} not found.`;
      }
    }
  }
}

registerTool(KnowledgeTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
