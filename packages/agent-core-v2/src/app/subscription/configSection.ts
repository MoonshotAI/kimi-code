import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { cloneRecord, isPlainObject, setDefined } from '#/app/config/toml';

export const SUBSCRIPTION_SECTION = 'subscription';

export const SubscriptionConfigSchema = z.record(z.string(), z.boolean());

export type SubscriptionConfig = z.infer<typeof SubscriptionConfigSchema>;

export const subscriptionFromToml = (rawSnake: unknown): unknown =>
  isPlainObject(rawSnake) ? cloneRecord(rawSnake) : rawSnake;

export const subscriptionToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    setDefined(out, key, entry);
  }
  return out;
};

registerConfigSection(SUBSCRIPTION_SECTION, SubscriptionConfigSchema, {
  fromToml: subscriptionFromToml,
  toToml: subscriptionToToml,
});
