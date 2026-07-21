/**
 * `externalHooks` domain (L5) — `hooks` config-section schema and TOML
 * transforms.
 *
 * Owns the `[[hooks]]` configuration section (external hook definitions),
 * including the snake_case ↔ camelCase TOML transforms for each hook entry.
 * Registered at module load via `registerConfigSection`, so the `config` domain
 * never imports this domain's types.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

import { HOOK_EVENT_TYPES } from './types';

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

export const hooksFromToml = (rawSnake: unknown): unknown => {
  if (!Array.isArray(rawSnake)) return rawSnake;
  return rawSnake.map((hook) => (isPlainObject(hook) ? transformPlainObject(hook) : hook));
};

export const hooksToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((hook) => (isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook));
};

registerConfigSection(HOOKS_SECTION, HooksConfigSchema, {
  fromToml: hooksFromToml,
  toToml: hooksToToml,
});
