import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    fork: z
      .boolean()
      .optional()
      .describe(
        'Fork the current context for every item-spawned subagent: each starts with a snapshot of this agent\'s completed conversation history instead of zero context, inheriting this agent\'s agent type, tool set, and model. A non-empty resume_agent_ids map is rejected. If subagent_type is provided, it must match this agent\'s type; if model is provided, it must be this agent\'s model or "primary". Different types and model overrides are rejected. Use it only when every item builds on this conversation; keep independent tasks zero-context.',
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the item-spawned subagents on: one of the aliases listed under "Available models" in this tool description, or "primary" for the main model you are running on (for hard, quality-sensitive tasks). When omitted, the configured default model is used. Resumed subagents always keep their own model.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
