/**
 * TowerSendTool — deliver an inbox message to a roster agent, the tower, or
 * everyone ("all"). The store builds the file name and frontmatter; agents
 * never write `.tower/comms/inbox/` by hand.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runTowerTool } from './support';

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

export class TowerSendTool implements BuiltinTool<TowerSendToolInput> {
  readonly name = 'TowerSend' as const;
  readonly description: string = `Send an inbox message to a tower participant: a roster agent by name, "tower" (the control tower), or "all" (broadcast).

Recipients read it with TowerInbox. Sending to yourself or to an unknown name is rejected — the error lists the known names.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSendToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerSendToolInput): ToolExecution {
    return {
      description: `Sending tower message to ${args.to}: ${args.subject}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);
          const rel = await store.send(caller, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
          });
          return { output: `message sent to ${args.to}\nfile: ${rel}` };
        }),
    };
  }
}
