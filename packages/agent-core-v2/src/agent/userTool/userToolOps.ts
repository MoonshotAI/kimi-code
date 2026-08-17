/**
 * `userTool` domain — the `userToolKey` state and the durable
 * `tools.register_user_tool` (`ToolsRegisterUserTool`) /
 * `tools.unregister_user_tool` (`ToolsUnregisterUserTool`) events for the set
 * of user-defined tools registered by the host.
 *
 * The state holds the registered user tools as a
 * `Map<string, UserToolRegistration>` (initial empty). Each fold keeps the
 * same reference when nothing changes (registering an already-equal tool /
 * unregistering an unknown name) so the state's reference-equality stays
 * quiet. The side effects — `registry.register` and `profile.addActiveTool`
 * (and the matching dispose / `removeActiveTool`) — are NOT part of the folds:
 * they run after dispatch on the live path and are re-derived from the rebuilt
 * state by the dispatcher's `onDidRestore` hook after restore, so a resumed
 * agent re-registers exactly the tools the persisted records describe.
 * Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { original } from 'immer';
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { UserToolRegistration } from './userTool';

export type UserToolModelState = Map<string, UserToolRegistration>;

const toolsRegisterUserToolSchema = z.custom<UserToolRegistration>();

export class ToolsRegisterUserTool extends Event2<z.infer<typeof toolsRegisterUserToolSchema>> {
  static override readonly type = 'tools.register_user_tool';
  static override readonly durable = true;
  static override readonly schema = toolsRegisterUserToolSchema;
}
export interface ToolsRegisterUserTool extends z.infer<typeof toolsRegisterUserToolSchema> {}

const toolsUnregisterUserToolSchema = z.object({ name: z.string() });

export class ToolsUnregisterUserTool extends Event2<
  z.infer<typeof toolsUnregisterUserToolSchema>
> {
  static override readonly type = 'tools.unregister_user_tool';
  static override readonly durable = true;
  static override readonly schema = toolsUnregisterUserToolSchema;
}
export interface ToolsUnregisterUserTool
  extends z.infer<typeof toolsUnregisterUserToolSchema> {}

function equalRegistration(a: UserToolRegistration, b: UserToolRegistration): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.parameters === b.parameters &&
    a.disclosure === b.disclosure
  );
}

export const userToolKey = defineState('userTool', (): UserToolModelState => new Map()).replayable({
  schema: z.custom<UserToolModelState>(),
})
  .on(ToolsRegisterUserTool, (s, e) => {
    const existing = s.get(e.name);
    if (existing !== undefined && equalRegistration(original(existing), e)) return;
    s.set(e.name, {
      name: e.name,
      description: e.description,
      parameters: e.parameters,
      disclosure: e.disclosure,
    });
  })
  .on(ToolsUnregisterUserTool, (s, e) => {
    if (!s.has(e.name)) return;
    s.delete(e.name);
  });
