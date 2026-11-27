import { join } from 'node:path';

import {
  ClientConfigClient,
  KIMI_CODE_PROVIDER_NAME,
  type ClientConfigFetchOptions,
  type KimiRegion,
} from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

export const AUTO_REVIEW_CLIENT_CONFIG_NAME = 'auto_review';
export const DEFAULT_AUTO_REVIEW_TIMEOUT_MS = 30000;

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const CLOUD_FETCH_TIMEOUT_MS = 2000;
const CLOUD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export interface AutoReviewCloudConfig {
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
}

const nonEmptyStringSchema = z.string().trim().min(1);
const timeoutMsSchema = z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS);

export const autoReviewCloudConfigSchema = z.unknown().transform((raw): AutoReviewCloudConfig => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const model = nonEmptyStringSchema.safeParse(record['model']);
  const effort = nonEmptyStringSchema.safeParse(record['effort']);
  const timeoutMs = timeoutMsSchema.safeParse(record['timeout_ms'] ?? record['timeoutMs']);
  return {
    ...(model.success ? { model: model.data } : {}),
    ...(effort.success ? { effort: effort.data } : {}),
    ...(timeoutMs.success ? { timeoutMs: timeoutMs.data } : {}),
  };
});

export interface IAutoReviewCloudConfigService {
  readonly _serviceBrand: undefined;
  warm(): void;
  peek(): AutoReviewCloudConfig | undefined;
  load(signal?: AbortSignal): Promise<AutoReviewCloudConfig | undefined>;
}

export const IAutoReviewCloudConfigService = createDecorator<IAutoReviewCloudConfigService>(
  'autoReviewCloudConfigService',
);

export interface AutoReviewCloudConfigServiceOptions {
  readonly client?: ClientConfigClient;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly cacheFile?: string | null;
}

export class AutoReviewCloudConfigService
  extends Service
  implements IAutoReviewCloudConfigService
{
  declare readonly _serviceBrand: undefined;
  private readonly client: ClientConfigClient;
  private readonly now: () => number;
  private readonly fetchImpl?: typeof fetch;
  private readonly cacheFile?: string | null;
  private inFlight:
    | { readonly region: KimiRegion; readonly promise: Promise<AutoReviewCloudConfig | undefined> }
    | undefined;
  private readonly failedAt = new Map<KimiRegion, number>();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IOAuthService private readonly auth: IOAuthService,
    options: AutoReviewCloudConfigServiceOptions = {},
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl;
    this.cacheFile = options.cacheFile;
    this.client =
      options.client ??
      new ClientConfigClient({
        region: () => this.auth.getRegion(),
        baseUrlOverride: () => this.bootstrap.getEnv('KIMI_CODE_BASE_URL'),
        cacheDir: () => join(this.bootstrap.cacheDir, 'client-configs'),
      });
  }

  warm(): void {
    void this.load().catch(() => undefined);
  }

  peek(): AutoReviewCloudConfig | undefined {
    return this.client.peek(AUTO_REVIEW_CLIENT_CONFIG_NAME, autoReviewCloudConfigSchema, this.now());
  }

  async load(signal?: AbortSignal): Promise<AutoReviewCloudConfig | undefined> {
    if (signal?.aborted) return undefined;
    try {
      const regionPromise = this.auth.getRegionAsync();
      if (signal === undefined) {
        await regionPromise;
      } else {
        await awaitWithAbort(regionPromise, signal);
      }
    } catch {}
    if (signal?.aborted) return undefined;
    const cached = this.peek();
    if (cached !== undefined) return cached;
    const region = this.client.region();
    const lastFailure = this.failedAt.get(region);
    if (lastFailure !== undefined && this.now() - lastFailure < CLOUD_FAILURE_COOLDOWN_MS) {
      return undefined;
    }
    const request = this.fetchOrJoin(region);
    if (signal === undefined) return request;
    return awaitWithAbort(request, signal);
  }

  private fetchOrJoin(region: KimiRegion): Promise<AutoReviewCloudConfig | undefined> {
    if (this.inFlight?.region === region) return this.inFlight.promise;
    const promise = this.fetchForRegion(region).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    });
    this.inFlight = { region, promise };
    return promise;
  }

  private async fetchForRegion(region: KimiRegion): Promise<AutoReviewCloudConfig | undefined> {
    let accessToken: string | undefined;
    try {
      accessToken = await this.auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME);
    } catch {
      accessToken = undefined;
    }
    const options: ClientConfigFetchOptions = {
      accessToken,
      now: this.now(),
      timeoutMs: CLOUD_FETCH_TIMEOUT_MS,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      ...(this.cacheFile === undefined ? {} : { cacheFile: this.cacheFile }),
    };
    const result = await this.client.get(
      AUTO_REVIEW_CLIENT_CONFIG_NAME,
      autoReviewCloudConfigSchema,
      options,
    );
    const resolvedRegion = this.client.region();
    if (result === undefined) {
      this.failedAt.set(region, this.now());
      this.failedAt.set(resolvedRegion, this.now());
    } else {
      this.failedAt.delete(region);
      this.failedAt.delete(resolvedRegion);
    }
    return result;
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => {
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(undefined);
      },
    );
  });
}
