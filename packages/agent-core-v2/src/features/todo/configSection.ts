import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TODO_SECTION = 'todo';

export const TODO_ENV = 'KIMI_CODE_TODO';

export const TODO_LIST_ENABLED_BY_DEFAULT = false;

export const TodoConfigSchema = z.object({
  enabled: z.boolean().optional(),
});

export type TodoConfig = z.infer<typeof TodoConfigSchema>;

export const todoEnvBindings: EnvBindings<TodoConfig> = envBindings(TodoConfigSchema, {
  enabled: { env: TODO_ENV, parse: parseBooleanEnv },
});

export const stripTodoEnv = stripEnvBoundFields(todoEnvBindings);

registerConfigSection(TODO_SECTION, TodoConfigSchema, {
  env: todoEnvBindings,
  stripEnv: stripTodoEnv,
});
