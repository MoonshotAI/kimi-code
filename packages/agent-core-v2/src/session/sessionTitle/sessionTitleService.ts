import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { SessionTitleGenerationFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';
import { IProviderService } from '#/llm-adapter/provider/provider';
import { isOAuthCatalogVendor } from '#/llm-adapter/provider/provider-definition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService, type SessionTitleSource } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

const MAX_TITLE_USER_SEGMENT = 400;

const MAX_TITLE_FIRST_TURN_ASSISTANT = 300;

const MAX_TITLE_DIGEST_USER_SEGMENT = 200;

const MAX_TITLE_DIGEST_ASSISTANT = 200;

const MAX_TITLE_DIGEST_INPUT_LENGTH = 3000;

type TitleGenerationResult =
  | { title: string; outcome: 'ok' | 'truncated' }
  | { title?: undefined; reason: NonNullable<SessionTitleGenerationFinishedEvent['reason']> };

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
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined> {
    const force = opts?.force === true;
    const source = opts?.source ?? 'user_prompts';
    if (force) return this.trackGeneration(true, source);
    if (this._shared !== undefined) return this._shared;
    const tracked = this.trackGeneration(false, source).finally(() => {
      if (this._shared === tracked) this._shared = undefined;
    });
    this._shared = tracked;
    return tracked;
  }

  private async trackGeneration(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    const trigger = force ? 'manual' : 'auto';
    const track = (
      result: Omit<SessionTitleGenerationFinishedEvent, 'duration_ms' | 'trigger' | 'source'>,
    ): void => {
      this.telemetry.track2('session_title_generation_finished', {
        ...result,
        trigger,
        source,
        duration_ms: Date.now() - startedAt,
      });
    };
    try {
      const result = await this.generateTitleOnce(force, source);
      if (result?.title !== undefined) {
        track({
          outcome: 'success',
          title_chars: result.title.length,
          title_outcome: result.outcome,
        });
      } else if (result !== undefined) {
        track({ outcome: 'unavailable', reason: result.reason });
      }
      return result?.title;
    } catch (error) {
      track({
        outcome: 'error',
        reason: 'unexpected',
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      throw error;
    }
  }

  private async generateTitleOnce(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<TitleGenerationResult | undefined> {
    const current = await this.metadata.read();
    if (!force) {
      if (current.titleKind === 'custom' || current.titleKind === 'generated') return undefined;
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return { reason: 'no_agent' };
    const promptSource = main.accessor.get(IAgentTitlePromptSource);
    const input = await composeTitleInput(promptSource, source);
    if (input === undefined) return { reason: 'no_input' };
    return this.generateAndApply(input, force);
  }

  private async generateAndApply(
    chatContent: string,
    force: boolean,
  ): Promise<TitleGenerationResult> {
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return { reason: 'custom_title' };
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return { reason: 'provider_unavailable' };
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) return { reason: 'token_unavailable' };
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return { reason: 'oauth_unavailable' };
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
        return { reason: 'oauth_unavailable' };
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return { reason: 'request_failed' };
    }
    const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return { reason: 'custom_title' };
    this.eventService.publish(
      new SessionMetaUpdated({
        payload: {
          agentId: 'main',
          sessionId: this.ctx.sessionId,
          title,
          patch: { title, isCustomTitle: false },
        },
      }),
    );
    return {
      title,
      outcome: result.title.length > MAX_GENERATED_TITLE_LENGTH ? 'truncated' : 'ok',
    };
  }
}

function titleInputFromPrompts(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt) => `user: ${prompt.slice(0, MAX_TITLE_USER_SEGMENT)}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

async function composeTitleInput(
  promptSource: IAgentTitlePromptSource,
  source: SessionTitleSource,
): Promise<string | undefined> {
  if (source === 'first_turn') {
    const excerpt = await promptSource.firstTurnExcerpt();
    if (excerpt.user === undefined || excerpt.assistant === undefined) return undefined;
    return [
      `user: ${excerpt.user.slice(0, MAX_TITLE_USER_SEGMENT)}`,
      `assistant: ${excerpt.assistant.slice(0, MAX_TITLE_FIRST_TURN_ASSISTANT)}`,
    ].join('\n');
  }
  if (source === 'digest') {
    const excerpt = await promptSource.digestExcerpt();
    const turns: string[][] = [];
    for (const turn of excerpt.turns) {
      const group = [`user: ${turn.user.slice(0, MAX_TITLE_DIGEST_USER_SEGMENT)}`];
      if (turn.assistant !== undefined) {
        group.push(`assistant: ${turn.assistant.slice(0, MAX_TITLE_DIGEST_ASSISTANT)}`);
      }
      turns.push(group);
    }
    return elideTitleDigestTurns(turns);
  }
  return titleInputFromPrompts(await promptSource.firstUserPrompts(MAX_TITLE_PROMPTS));
}

const TITLE_DIGEST_ELISION_MARKER = '...';

function elideTitleDigestTurns(turns: readonly (readonly string[])[]): string | undefined {
  if (turns.length === 0) return undefined;
  const joined = turns.flat().join('\n');
  if (joined.length <= MAX_TITLE_DIGEST_INPUT_LENGTH) return joined;
  let budget = MAX_TITLE_DIGEST_INPUT_LENGTH - TITLE_DIGEST_ELISION_MARKER.length - 2;
  const head: string[] = [];
  for (const line of turns[0]!) {
    if (budget < line.length + 1) break;
    head.push(line);
    budget -= line.length + 1;
  }
  const tail: string[] = [];
  for (let index = turns.length - 1; index >= 1; index--) {
    const group = turns[index]!;
    const cost = group.reduce((sum, line) => sum + line.length + 1, 0);
    if (budget < cost) break;
    tail.unshift(...group);
    budget -= cost;
  }
  return [...head, TITLE_DIGEST_ELISION_MARKER, ...tail].join('\n');
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
