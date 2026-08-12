/**
 * `sessionTitle` domain (L6) — `ISessionTitleService` implementation.
 *
 * Generates the session's title from the first active prompts in the main
 * Agent's live conversation context through the managed platform `/tools`
 * `chat_title` endpoint, persists it through
 * `sessionMetadata`, and rebroadcasts `session.meta.updated`.
 * Generation is on demand only: `generateTitle()` is the single entry point
 * (the kap-server route), gated by a managed Kimi Code OAuth login; any
 * failure degrades to keeping the current title, and a custom title set by
 * the user is never overwritten. An already-generated title is not
 * regenerated. Concurrent calls coalesce onto one shared in-flight
 * generation. `force` requests an explicit user-driven regeneration: it
 * bypasses the in-flight coalescing and both title-kind guards, and the
 * applied title is marked `generated` (a previous custom marking is
 * dropped).
 * Provider config comes
 * from `provider`, the bearer token from `auth`, host identity headers from
 * `model`, prompt history from `agentLifecycle`/`sessionTitle`, and logs
 * through `log`. Bound at Session scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

export class SessionTitleService implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _shared: Promise<string | undefined> | undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(opts?: { force?: boolean }): Promise<string | undefined> {
    const force = opts?.force === true;
    if (force) return this.generateTitleOnce(true);
    if (this._shared !== undefined) return this._shared;
    const tracked = this.generateTitleOnce(false).finally(() => {
      if (this._shared === tracked) this._shared = undefined;
    });
    this._shared = tracked;
    return tracked;
  }

  private async generateTitleOnce(force: boolean): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (!force) {
      if (current.titleKind === 'custom') return undefined;
      if (current.titleKind === 'generated') return undefined;
    }
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    const prompts =
      main === undefined
        ? []
        : await main.accessor.get(IAgentTitlePromptSource).firstUserPrompts(MAX_TITLE_PROMPTS);
    const input = titleInputFromPrompts(prompts);
    if (input === undefined) return undefined;
    return this.generateAndApply(input, force);
  }

  private async generateAndApply(
    chatContent: string,
    force: boolean,
  ): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return undefined;
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return undefined;
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) return undefined;
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return undefined;
    }
    const requestTitle = (accessToken: string) =>
      fetchChatTitle(kimiCodeToolsUrl(runtimeAuth.baseUrl), accessToken, chatContent, {
        headers: {
          ...parseKimiCodeCustomHeaders(),
          ...this.hostHeaders.headers,
          ...provider.customHeaders,
        },
      });
    let result = await requestTitle(token);
    if (result.kind === 'error' && result.status === 401) {
      try {
        token = await tokenProvider.getAccessToken({ force: true });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        this.log.debug(`chat_title request unavailable: ${error.message}`);
        return undefined;
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return undefined;
    }
    const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return undefined;
    this.eventService.publish({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: this.ctx.sessionId,
        title,
        patch: { title, isCustomTitle: false },
      },
    });
    return title;
  }
}

function titleInputFromPrompts(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt) => `user: ${prompt}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
