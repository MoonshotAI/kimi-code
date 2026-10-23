import { Emitter, type Event } from '#/_base/event';
import type { IOAuthService } from '#/app/auth/auth';
import {
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigInspectValue,
  IConfigService,
  type ResolvedConfig,
} from '#/app/config/config';
import type { IProviderDiscoveryService, RetiredModel } from '#/app/kosongConfig/discovery';
import type { IModelOAuthTokens } from '#/llm-adapter/model/model-oauth';
import type { ISessionLockService } from '#/persistence/interface/sessionLock';
import type { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';

export class StubConfigService implements IConfigService {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly _onDidChange = new Emitter<ConfigChangedEvent>();
  readonly onDidChangeConfiguration: Event<ConfigChangedEvent> = this._onDidChange.event;
  readonly onDidSectionChange: Event<ConfigChangedEvent> = this._onDidChange.event;
  private readonly _onDidChangeDiagnostics = new Emitter<readonly ConfigDiagnostic[]>();
  readonly onDidChangeDiagnostics: Event<readonly ConfigDiagnostic[]> =
    this._onDidChangeDiagnostics.event;
  private readonly _values = new Map<string, unknown>();

  constructor(initial?: Record<string, unknown>) {
    for (const [domain, value] of Object.entries(initial ?? {})) {
      this._values.set(domain, value);
    }
  }

  get<T = unknown>(domain: string): T {
    return this._values.get(domain) as T;
  }

  inspect<T = unknown>(domain: string): ConfigInspectValue<T> {
    return {
      value: this._values.get(domain) as T | undefined,
      defaultValue: undefined,
      userValue: this._values.get(domain) as T | undefined,
      memoryValue: undefined,
    };
  }

  getAll(): ResolvedConfig {
    return Object.fromEntries(this._values) as ResolvedConfig;
  }

  set(domain: string, patch: unknown): Promise<void> {
    const previousValue = this._values.get(domain);
    const value =
      patch !== null && typeof patch === 'object'
        ? { ...(previousValue as Record<string, unknown> | undefined), ...patch }
        : patch;
    this._values.set(domain, value);
    this._onDidChange.fire({ domain, source: 'set', value, previousValue });
    return Promise.resolve();
  }

  replace(domain: string, value: unknown): Promise<void> {
    const previousValue = this._values.get(domain);
    if (value === undefined || value === null) {
      this._values.delete(domain);
    } else {
      this._values.set(domain, value);
    }
    this._onDidChange.fire({ domain, source: 'set', value, previousValue });
    return Promise.resolve();
  }

  replaceSections(sections: Readonly<Record<string, unknown>>): Promise<void> {
    for (const [domain, value] of Object.entries(sections)) {
      const previousValue = this._values.get(domain);
      if (value === undefined || value === null) {
        this._values.delete(domain);
      } else {
        this._values.set(domain, value);
      }
      this._onDidChange.fire({ domain, source: 'set', value, previousValue });
    }
    return Promise.resolve();
  }

  setSilent(domain: string, value: unknown): void {
    if (value === undefined) {
      this._values.delete(domain);
    } else {
      this._values.set(domain, value);
    }
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [];
  }
}

export interface StubTokenProvider {
  getAccessToken(options?: { force?: boolean }): Promise<string>;
  readonly calls: Array<{ force?: boolean }>;
}

export function stubTokenProvider(tokens: readonly string[]): StubTokenProvider {
  const calls: Array<{ force?: boolean }> = [];
  let index = 0;
  return {
    calls,
    getAccessToken(options?: { force?: boolean }) {
      calls.push(options ?? {});
      const token = tokens[Math.min(index, tokens.length - 1)];
      index += 1;
      return Promise.resolve(token ?? '');
    },
  };
}

export function stubOAuthService(tokenProvider?: StubTokenProvider): IOAuthService {
  return {
    _serviceBrand: undefined,
    startLogin: () => Promise.reject(new Error('not implemented')),
    getFlow: () => undefined,
    cancelLogin: () => Promise.reject(new Error('not implemented')),
    logout: () => Promise.reject(new Error('not implemented')),
    status: () => Promise.resolve({ loggedIn: false }),
    refreshOAuthProviderModels: () => Promise.reject(new Error('not implemented')),
    resolveTokenProvider: () => tokenProvider,
    getCachedAccessToken: () => Promise.resolve(undefined),
  } as unknown as IOAuthService;
}

export interface StubProviderDiscovery extends IProviderDiscoveryService {
  readonly retired: Record<string, string>;
  retire(event: RetiredModel): void;
}

export function stubProviderDiscovery(): StubProviderDiscovery {
  const retirements = new Emitter<RetiredModel>();
  const retired: Record<string, string> = {};
  return {
    _serviceBrand: undefined,
    retired,
    onDidRetireModel: retirements.event,
    refreshProviderModels: () => Promise.reject(new Error('not implemented')),
    retiredModelReplacement: (alias) => retired[alias],
    retire: (event) => {
      retired[event.from] = event.to;
      retirements.fire(event);
    },
  };
}

export function stubModelOAuthTokens(
  tokenProvider?: StubTokenProvider,
  cachedToken?: string,
): IModelOAuthTokens {
  return {
    _serviceBrand: undefined,
    hasCachedAccessToken: () => Promise.resolve(cachedToken !== undefined),
    getAccessToken: (_provider, _oauthRef, options) =>
      tokenProvider === undefined
        ? Promise.reject(new Error('auth.login_required'))
        : tokenProvider.getAccessToken(
            options?.force === true ? { force: true } : undefined,
          ),
  };
}

export function stubSessionRunGate(
  locks: ISessionLockService,
  sessionId = 'test-session',
): ISessionRunGate {
  return {
    _serviceBrand: undefined,
    begin: () => locks.hold(sessionId),
  };
}
