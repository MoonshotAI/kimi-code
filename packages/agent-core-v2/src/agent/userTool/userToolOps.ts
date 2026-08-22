/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { original } from 'immer';
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { UserToolRegistration } from './userTool';

export type UserToolModelState = Map<string, UserToolRegistration>;

const toolsRegisterUserToolSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  parameters: z.custom<UserToolRegistration['parameters']>(),
  disclosure: z.custom<UserToolRegistration['disclosure']>().optional(),
});

export class ToolsRegisterUserTool extends AgentEvent2<
  z.infer<typeof toolsRegisterUserToolSchema>
> {
  static override readonly type = 'tools.register_user_tool';
  static override readonly durable = true;
  static override readonly schema = toolsRegisterUserToolSchema;
}
export interface ToolsRegisterUserTool extends UserToolRegistration {
  readonly agentId: string;
}

const toolsUnregisterUserToolSchema = z.object({
  agentId: z.string(),
  name: z.string(),
});

export class ToolsUnregisterUserTool extends AgentEvent2<
  z.infer<typeof toolsUnregisterUserToolSchema>
> {
  static override readonly type = 'tools.unregister_user_tool';
  static override readonly durable = true;
  static override readonly schema = toolsUnregisterUserToolSchema;
}
export interface ToolsUnregisterUserTool {
  readonly agentId: string;
  readonly name: string;
}

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
