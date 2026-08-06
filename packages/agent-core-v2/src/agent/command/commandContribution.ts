/**
 * `command` domain — the `CommandContribution` collection token and payload.
 *
 * An executable command a Feature (or any unit) contributes into the
 * agent-scope registry (`IAgentCommandService`) — unlike plugin commands,
 * which are prompt templates, a contributed command runs engine-side with DI
 * access. `run` receives a `CommandRunContext` whose `get` resolves services
 * from the target agent's container; the records carry the provider unit's
 * name as `source`, and a record is withdrawn when its provider dies. No
 * scoped state — pure payload + token.
 */

import { collection } from '#/_base/di/collection';
import type { ServiceIdentifier } from '#/_base/di/instantiation';

export interface CommandRunContext {
  readonly args: string;
  get<T>(id: ServiceIdentifier<T>): T;
}

export interface CommandContribution {
  readonly name: string;
  readonly description?: string;
  readonly run: (ctx: CommandRunContext) => void | Promise<void>;
}

export const CommandContribution = collection<CommandContribution>('command');
