import { join } from 'node:path';

import { ClientConfigClient, KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { abortable } from '#/_base/utils/abort';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

export const AUTO_REVIEW_CLIENT_CONFIG_NAME = 'auto_review';
export const DEFAULT_AUTO_REVIEW_TIMEOUT_MS = 30000;

const CLOUD_FETCH_TIMEOUT_MS = 2000;
const CLOUD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export const autoReviewCloudConfigSchema = z
  .object({
    model: z.string().trim().min(1).optional().catch(undefined),
    effort: z.string().trim().min(1).optional().catch(undefined),
    timeout_ms: z.number().int().min(1000).max(120000).optional().catch(undefined),
  })
  .catch({});

export type AutoReviewCloudConfig = z.infer<typeof autoReviewCloudConfigSchema>;

export interface IAutoReviewCloudConfigService {
  readonly _serviceBrand: undefined;
  load(signal: AbortSignal): Promise<AutoReviewCloudConfig | undefined>;
}

export const IAutoReviewCloudConfigService = createDecorator<IAutoReviewCloudConfigService>(
  'autoReviewCloudConfigService',
);

export class AutoReviewCloudConfigService extends Service implements IAutoReviewCloudConfigService {
  declare readonly _serviceBrand: undefined;
  private pending: Promise<AutoReviewCloudConfig | undefined> | undefined;
  private failedAt: number | undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IOAuthService private readonly auth: IOAuthService,
    private readonly client: ClientConfigClient = new ClientConfigClient({
      region: () => auth.getRegion(),
      baseUrlOverride: () => bootstrap.getEnv('KIMI_CODE_BASE_URL'),
      cacheDir: () => join(bootstrap.cacheDir, 'client-configs'),
    }),
  ) {
    super();
  }

  load(signal: AbortSignal): Promise<AutoReviewCloudConfig | undefined> {
    this.pending ??= this.fetch().finally(() => {
      this.pending = undefined;
    });
    return abortable(this.pending, signal).catch(() => undefined);
  }

  private async fetch(): Promise<AutoReviewCloudConfig | undefined> {
    await this.auth.getRegionAsync().catch(() => undefined);
    const cached = this.client.peek(AUTO_REVIEW_CLIENT_CONFIG_NAME, autoReviewCloudConfigSchema);
    if (cached !== undefined) return cached;
    if (this.failedAt !== undefined && Date.now() - this.failedAt < CLOUD_FAILURE_COOLDOWN_MS) return undefined;
    const accessToken = await this.auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME).catch(() => undefined);
    const config = await this.client.get(AUTO_REVIEW_CLIENT_CONFIG_NAME, autoReviewCloudConfigSchema, {
      accessToken,
      timeoutMs: CLOUD_FETCH_TIMEOUT_MS,
    });
    this.failedAt = config === undefined ? Date.now() : undefined;
    return config;
  }
}
