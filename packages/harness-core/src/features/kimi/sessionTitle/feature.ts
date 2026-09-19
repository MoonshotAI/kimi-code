import {
  createFeature,
  MAIN_AGENT_ID,
  useAgentStore,
  useApp,
  useProviderCatalog,
  useSession,
  type FeatureSlots,
  type FeatureSpec,
  type SessionRecord,
} from '@moonshot-ai/agent-core';
import { createToken, inject, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';
import {
  fetchChatTitle,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeToolsUrl,
  OAuthError,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';

import { OAuthTokensRef } from '../oauth/index';

import { composeTitleInput, type SessionTitleSource } from './excerpt';

export type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

export interface SessionTitleFace {
  generateTitle(opts?: { force?: boolean; source?: SessionTitleSource }): Promise<string | undefined>;
}

export const SessionTitleRef = createToken<SessionTitleFace>('sessionTitle');

export function useSessionTitle(): SessionTitleFace {
  return inject(SessionTitleRef);
}

export interface SessionTitlePromptSource {
  compose(source: SessionTitleSource): string | undefined;
}

export const SessionTitlePromptSourceRef = createToken<SessionTitlePromptSource>(
  'sessionTitle.promptSource',
);

const MAX_GENERATED_TITLE_LENGTH = 200;

interface TitleChannel {
  readonly baseUrl?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly tokens: BearerTokenProvider;
}

export const sessionTitleSlots: FeatureSlots = {
  session() {
    const node = useNode();
    const app = useApp();
    const session = useSession();
    const catalog = useProviderCatalog();
    const oauthEntries = node.providerRef(OAuthTokensRef);
    let shared: Promise<string | undefined> | undefined;
    const channel = (): TitleChannel | undefined => {
      const info = catalog.providerInfo(KIMI_CODE_PROVIDER_NAME);
      if (info?.modelSource !== 'oauth-catalog' || info.oauth === undefined) return undefined;
      const runtimeAuth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: info.baseUrl,
        configuredOAuthRef: info.oauth,
      });
      const tokens = oauthEntries.value.at(-1)?.value.resolve(runtimeAuth.oauthRef);
      if (tokens === undefined) return undefined;
      return { baseUrl: runtimeAuth.baseUrl, customHeaders: info.customHeaders, tokens };
    };
    const promptSourceOfMain = (): SessionTitlePromptSource | undefined => {
      const main = session.get(MAIN_AGENT_ID);
      if (main === undefined) return undefined;
      try {
        return main.resolve(SessionTitlePromptSourceRef);
      } catch {
        return undefined;
      }
    };
    const generateAndApply = async (
      chatContent: string,
      force: boolean,
    ): Promise<string | undefined> => {
      const active = channel();
      if (active === undefined) return undefined;
      let accessToken: string;
      try {
        accessToken = await active.tokens.getAccessToken();
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        return undefined;
      }
      const requestTitle = (bearer: string) =>
        fetchChatTitle(kimiCodeToolsUrl(active.baseUrl), bearer, chatContent, {
          headers: { ...parseKimiCodeCustomHeaders(), ...active.customHeaders },
        });
      let result = await requestTitle(accessToken);
      if (result.kind === 'error' && result.status === 401) {
        try {
          accessToken = await active.tokens.getAccessToken({ force: true });
        } catch (error) {
          if (!(error instanceof OAuthError)) throw error;
          return undefined;
        }
        result = await requestTitle(accessToken);
      }
      if (result.kind !== 'ok') return undefined;
      const title = result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
      const current = await app.space.get(session.sessionId);
      if (!force && titleKindOf(current) === 'custom') return undefined;
      await app.updateSession(session.sessionId, {
        title,
        metadata: { ...current?.metadata, titleKind: 'generated' },
      });
      return title;
    };
    const generateTitleOnce = async (
      force: boolean,
      source: SessionTitleSource,
    ): Promise<string | undefined> => {
      if (!force) {
        const kind = titleKindOf(await app.space.get(session.sessionId));
        if (kind === 'custom' || kind === 'generated') return undefined;
      }
      const promptSource = promptSourceOfMain();
      if (promptSource === undefined) return undefined;
      const input = promptSource.compose(source);
      if (input === undefined) return undefined;
      return generateAndApply(input, force);
    };
    useExpose(SessionTitleRef, {
      generateTitle: (opts) => {
        const force = opts?.force === true;
        const source = opts?.source ?? 'user_prompts';
        if (force) return generateTitleOnce(true, source);
        if (shared !== undefined) return shared;
        const tracked = generateTitleOnce(false, source).finally(() => {
          if (shared === tracked) shared = undefined;
        });
        shared = tracked;
        return tracked;
      },
    });
  },
  agent() {
    const store = useAgentStore();
    useExpose(SessionTitlePromptSourceRef, {
      compose: (source) => composeTitleInput(store.getState().history, source),
    });
  },
};

export const sessionTitle: FeatureSpec = createFeature('sessionTitle', sessionTitleSlots);

function titleKindOf(record: SessionRecord | undefined): SessionTitleKind | undefined {
  const value = record?.metadata?.['titleKind'];
  if (value === 'replaceable' || value === 'generated' || value === 'custom') return value;
  return record?.title === undefined ? undefined : 'replaceable';
}
