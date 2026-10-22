import { z } from 'zod';

import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import { BROADCAST_NAME, TOWER_NAME } from '../protocol/index';

import DESCRIPTION from './send.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

export const TowerSendToolInputSchema = z
  .object({
    to: z
      .string()
      .describe('Recipient: a roster agent name, "tower", or "all" (broadcast)'),
    subject: z.string().describe('One-line subject; keep it greppable'),
    body: z.string().describe('Full message body (markdown)'),
    scope: z.string().optional().describe('Optional scope tag (e.g. the mission id)'),
    action: z.string().optional().describe('Optional action tag for machine routing'),
    consent_ref: z
      .string()
      .optional()
      .describe('Optional reference to a consent/approval record this message relies on'),
  })
  .strict();

export type TowerSendToolInput = z.infer<typeof TowerSendToolInputSchema>;

export function createTowerSendTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerSend',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerSendToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerSendToolInputSchema, toolCall.arguments, 'TowerSend');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);
        const to = args.to.trim();
        const rel = await store.send(caller, {
          to,
          subject: args.subject,
          body: args.body,
          scope: args.scope,
          action: args.action,
          consentRef: args.consent_ref,
        });
        if (caller !== TOWER_NAME && (to === TOWER_NAME || to === BROADCAST_NAME)) {
          deps.hub.publish({ from: caller, to, subject: args.subject });
        }
        const entry =
          caller === TOWER_NAME && to !== TOWER_NAME && to !== BROADCAST_NAME
            ? state.roster.agents.find((agent) => agent.name === to)
            : undefined;
        const note =
          entry !== undefined && !deps.running.has(entry.agentId)
            ? `\nnote: ${to} has no running task in this session — the message sits in its inbox until you deliver it with Agent(resume="${entry.agentId}", run_in_background=true, prompt="...")`
            : '';
        return text(`message sent to ${args.to}\nfile: ${rel}${note}`);
      });
    },
  };
}
