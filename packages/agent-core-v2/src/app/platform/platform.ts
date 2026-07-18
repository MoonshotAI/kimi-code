/**
 * `platform` domain (L2) — auth-holder registry contract.
 *
 * A Platform is a rebound identity/auth boundary: "these credentials, this
 * OAuth flow, this env-bag of secrets grants access to a family of Providers".
 * A single Platform can back multiple Providers (Moonshot exposes both
 * OpenAI-compat and Anthropic-compat endpoints under one OAuth login;
 * Bedrock-hosted Anthropic uses the AWS Platform with its regional endpoints).
 *
 * The Platform explicitly does **not** carry a base URL — that's the
 * Provider's responsibility. This split lets Providers share a login without
 * being tied to the same endpoint origin.
 *
 * Bound at App scope; provider/model configuration is global and shared
 * across sessions. Higher-level services (auth, modelResolver, CLI, UI)
 * mutate platforms through this domain instead of writing config directly.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { OAuthRefSchema } from '#/app/provider/provider';

const StringRecordSchema = z.record(z.string(), z.string());

export const PlatformAuthSchema = z
  .object({
    apiKey: z.string().optional(),
    oauth: OAuthRefSchema.optional(),
    env: StringRecordSchema.optional(),
  })
  .refine((v) => v.apiKey !== undefined || v.oauth !== undefined || v.env !== undefined, {
    message: 'PlatformAuth must provide at least one of apiKey, oauth, or env',
  });

export type PlatformAuth = z.infer<typeof PlatformAuthSchema>;

export const PlatformConfigSchema = z.object({
  auth: PlatformAuthSchema.optional(),
  displayName: z.string().optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

export const PLATFORMS_SECTION = 'platforms';

export const UNKNOWN_PLATFORM_KEY = '__unknown__';

export const PlatformsSectionSchema = z.record(z.string(), PlatformConfigSchema);

export type PlatformsSection = z.infer<typeof PlatformsSectionSchema>;

export interface PlatformsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface IPlatformService {
  readonly _serviceBrand: undefined;

  readonly onDidChangePlatforms: Event<PlatformsChangedEvent>;
  get(name: string): PlatformConfig | undefined;
  list(): Readonly<Record<string, PlatformConfig>>;
  set(name: string, config: PlatformConfig): Promise<void>;
  delete(name: string): Promise<void>;
}

export const IPlatformService: ServiceIdentifier<IPlatformService> =
  createDecorator<IPlatformService>('platformService');
