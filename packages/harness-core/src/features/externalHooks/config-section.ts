import { z } from 'zod';

import {
  isPlainObject,
  plainObjectToToml,
  transformPlainObject,
  type ConfigSectionContribution,
} from '#/features/config/index';

import { HOOK_EVENT_TYPES, type HookDef } from './internal/types';

export const HOOKS_SECTION = 'hooks';

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export type HookDefConfig = z.infer<typeof HookDefSchema>;

export const HooksConfigSchema = z.array(HookDefSchema);

const hooksFromToml = (rawSnake: unknown): unknown => {
  if (!Array.isArray(rawSnake)) return rawSnake;
  return rawSnake.map((hook) => (isPlainObject(hook) ? transformPlainObject(hook) : hook));
};

const hooksToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((hook) => (isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook));
};

export const hooksConfigSection: ConfigSectionContribution<HookDef[]> = {
  name: HOOKS_SECTION,
  schema: HooksConfigSchema,
  fromToml: hooksFromToml,
  toToml: hooksToToml,
};
