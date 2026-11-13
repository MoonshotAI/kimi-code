import {
  apiKeyEnvMissingMessage,
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  fetchSubmitFeedback,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeFeedbackUrl,
  resolveKimiCodeRuntimeAuth,
  type SubmitFeedbackBody,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { IModelService, type ModelRecord, type ModelsSection } from '#/llm-adapter/model/model';
import { resolveModelAuthMaterial } from '#/llm-adapter/model/model-auth';
import type { ResolvedModelAuthMaterial } from '#/llm-adapter/model/model.types';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/llm-adapter/provider/provider';

import {
  IFeedbackService,
  type FeedbackAvailability,
  type FeedbackCompleteResult,
  type FeedbackCompleteUploadInput,
  type FeedbackSubmitInput,
  type FeedbackSubmitResult,
  type FeedbackUploadUrlInput,
  type FeedbackUploadUrlResult,
} from './feedback';

type FeedbackTarget =
  | {
      readonly kind: 'custom';
      readonly url: string;
      readonly token: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'managed'; readonly baseUrl?: string; readonly token: string }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export class FeedbackService implements IFeedbackService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  async availability(modelAlias?: string): Promise<FeedbackAvailability> {
    const target = await this.resolveTarget(modelAlias, false);
    if (target.kind === 'custom' || target.kind === 'managed') return { kind: 'ready' };
    return target;
  }

  async submit(input: FeedbackSubmitInput, modelAlias?: string): Promise<FeedbackSubmitResult> {
    const target = await this.resolveTarget(modelAlias, true);
    if (target.kind !== 'custom' && target.kind !== 'managed') return target;
    const body: SubmitFeedbackBody = {
      session_id: input.sessionId,
      content: input.content,
      version: input.version,
      os: input.os,
      model: input.model,
      contact: input.contact,
      info: input.info,
    };
    const result =
      target.kind === 'custom'
        ? await fetchSubmitFeedback(target.url, target.token, body, { headers: target.headers })
        : await fetchSubmitFeedback(kimiCodeFeedbackUrl(target.baseUrl), target.token, body);
    if (result.kind === 'error') return { kind: 'error', message: result.message };
    return { kind: 'ok', feedbackId: result.feedbackId };
  }

  async createUploadUrl(
    input: FeedbackUploadUrlInput,
    modelAlias?: string,
  ): Promise<FeedbackUploadUrlResult> {
    const target = await this.resolveTarget(modelAlias, true);
    if (target.kind !== 'custom' && target.kind !== 'managed') return target;
    const body = {
      file_hash: input.sha256,
      file_name: input.filename,
      file_size: input.size,
      feedback_id: input.feedbackId,
    };
    const result =
      target.kind === 'custom'
        ? await fetchCreateFeedbackUploadUrl(target.token, body, {
            feedbackUrl: target.url,
            headers: target.headers,
          })
        : await fetchCreateFeedbackUploadUrl(target.token, body, { baseUrl: target.baseUrl });
    if (result.kind === 'error') return { kind: 'error', message: result.message };
    return {
      kind: 'ok',
      uploadId: result.upload_id,
      parts: result.parts.map((part) => ({
        partNumber: part.part_number,
        url: part.url,
        method: part.method,
        size: part.size,
      })),
    };
  }

  async completeUpload(
    input: FeedbackCompleteUploadInput,
    modelAlias?: string,
  ): Promise<FeedbackCompleteResult> {
    const target = await this.resolveTarget(modelAlias, true);
    if (target.kind !== 'custom' && target.kind !== 'managed') return target;
    const body = {
      upload_id: input.uploadId,
      parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
    };
    const result =
      target.kind === 'custom'
        ? await fetchCompleteFeedbackUpload(target.token, body, {
            feedbackUrl: target.url,
            headers: target.headers,
          })
        : await fetchCompleteFeedbackUpload(target.token, body, { baseUrl: target.baseUrl });
    if (result.kind === 'error') return result;
    return { kind: 'ok' };
  }

  private async resolveTarget(modelAlias: string | undefined, refresh: boolean): Promise<FeedbackTarget> {
    const custom = this.customProvider(modelAlias);
    if (custom !== undefined) return this.customTarget(custom, refresh);
    return this.managedTarget(refresh);
  }

  private customProvider(modelAlias: string | undefined):
    | {
        modelId: string;
        model: ModelRecord;
        providerName: string;
        provider: ProviderConfig;
        feedbackUrl: string;
      }
    | undefined {
    const modelId = nonEmpty(modelAlias);
    if (modelId === undefined) return undefined;
    const model = this.models.get(modelId) ?? this.config.get<ModelsSection>(MODELS_SECTION)?.[modelId];
    if (model === undefined) return undefined;
    const providerName = nonEmpty(model.provider ?? model.providerId);
    if (providerName === undefined) return undefined;
    const provider =
      this.providers.get(providerName) ?? this.config.get<ProvidersSection>(PROVIDERS_SECTION)?.[providerName];
    const feedbackUrl = nonEmpty(provider?.feedbackUrl);
    if (provider === undefined || feedbackUrl === undefined) return undefined;
    return { modelId, model, providerName, provider, feedbackUrl };
  }

  private async customTarget(
    resolved: {
      modelId: string;
      model: ModelRecord;
      providerName: string;
      provider: ProviderConfig;
      feedbackUrl: string;
    },
    refresh: boolean,
  ): Promise<FeedbackTarget> {
    let auth: ResolvedModelAuthMaterial;
    try {
      auth = resolveModelAuthMaterial(resolved);
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    const credential = await this.bearer(resolved.providerName, auth, refresh);
    if ('kind' in credential) return credential;
    return {
      kind: 'custom',
      url: resolved.feedbackUrl,
      token: credential.token,
      headers: resolved.provider.customHeaders,
    };
  }

  private async bearer(
    providerName: string,
    auth: ResolvedModelAuthMaterial,
    refresh: boolean,
  ): Promise<{ readonly token: string } | { readonly kind: 'error'; readonly message: string }> {
    if (auth.apiKey !== undefined) return { token: auth.apiKey };
    if (auth.apiKeyEnv !== undefined) {
      const value = nonEmpty(process.env[auth.apiKeyEnv]);
      if (value === undefined) {
        return { kind: 'error', message: apiKeyEnvMissingMessage(providerName, auth.apiKeyEnv) };
      }
      return { token: value };
    }
    if (auth.oauth !== undefined) {
      const key = auth.oauthProviderKey ?? providerName;
      const token = refresh
        ? await this.oauth.resolveTokenProvider(key, auth.oauth)?.getAccessToken()
        : await this.oauth.getCachedAccessToken(key, auth.oauth);
      if (token === undefined) {
        return {
          kind: 'error',
          message: `Provider "${providerName}" declares feedback_url but has no OAuth token.`,
        };
      }
      return { token };
    }
    return {
      kind: 'error',
      message: `Provider "${providerName}" declares feedback_url but has no usable credential.`,
    };
  }

  private async managedTarget(refresh: boolean): Promise<FeedbackTarget> {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider?.baseUrl,
      configuredOAuthRef: provider?.oauth,
    });
    if (!refresh) {
      const status = await this.oauth.status(KIMI_CODE_PROVIDER_NAME);
      if (!status.loggedIn) return { kind: 'needs-login' };
      const token = await this.oauth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (token === undefined) return { kind: 'needs-login' };
      return { kind: 'managed', baseUrl: auth.baseUrl, token };
    }
    const tokenProvider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
    if (tokenProvider === undefined) return { kind: 'needs-login' };
    try {
      return { kind: 'managed', baseUrl: auth.baseUrl, token: await tokenProvider.getAccessToken() };
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IFeedbackService,
  FeedbackService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
