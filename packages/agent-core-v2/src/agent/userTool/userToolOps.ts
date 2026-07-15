/**
 * `userTool` domain (L4) — wire Model (`UserToolModel`) and the
 * `tools.register_user_tool` (`registerUserTool`) / `tools.unregister_user_tool`
 * (`unregisterUserTool`) Ops for the set of user-defined tools registered by the
 * host.
 *
 * Declares the registered user tools as a `Map<string, UserToolRegistration>`
 * wire Model (initial empty), plus the two Ops whose `apply` functions are the
 * pure extraction of the former live `applyRegister` / `applyUnregister` Map
 * mutations and their `record.define(...resume...)` facets (their common
 * transition). Each returns the same reference when nothing changes (registering
 * an already-equal tool / unregistering an unknown name) so the wire's
 * reference-equality gate stays quiet. The side effects — `registry.register`
 * and `profile.addActiveTool` (and the matching dispose / `removeActiveTool`) —
 * are NOT part of `apply`: they run after `wire.dispatch` on the live path and
 * are re-derived from the rebuilt Model by `wire.hooks.onDidRestore` after
 * restore, so a resumed agent re-registers exactly the tools the persisted ops
 * describe.
 * Consumed by the Agent-scope `userToolService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { UserToolRegistration } from './userTool';

export type UserToolModelState = Map<string, UserToolRegistration>;

export const UserToolModel = defineModel<UserToolModelState>('userTool', () => new Map());

declare module '#/wire/types' {
  interface PersistedOpMap {
    'tools.register_user_tool': typeof registerUserTool;
    'tools.unregister_user_tool': typeof unregisterUserTool;
  }
}

function equalRegistration(a: UserToolRegistration, b: UserToolRegistration): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.parameters === b.parameters
  );
}

export const registerUserTool = UserToolModel.defineOp('tools.register_user_tool', {
  schema: z.custom<UserToolRegistration>(),
  apply: (s, p) => {
    const existing = s.get(p.name);
    if (existing !== undefined && equalRegistration(existing, p)) return s;
    const next = new Map(s);
    next.set(p.name, p);
    return next;
  },
});

export const unregisterUserTool = UserToolModel.defineOp('tools.unregister_user_tool', {
  schema: z.object({ name: z.string() }),
  apply: (s, p) => {
    if (!s.has(p.name)) return s;
    const next = new Map(s);
    next.delete(p.name);
    return next;
  },
});
