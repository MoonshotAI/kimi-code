import { isDeepStrictEqual } from 'node:util';

const REQUEST_TIMEOUT_MS = 30_000;

type GrantType = 'refresh_token' | 'authorization_code';
type Effect<T> =
  | { readonly kind: 'save'; readonly tokens: T }
  | {
      readonly kind: 'invalidate';
      readonly grantType: GrantType;
      readonly error: string;
      readonly tokensAtFailure: T | undefined;
      readonly alreadyRemoved: boolean;
      readonly preserveCurrent: boolean;
    };

export interface OAuthTokenTransactionOptions<T extends object> {
  readonly key: string;
  readonly read: () => Promise<T | undefined>;
  readonly write: (tokens: T) => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly parse: (value: unknown) => T | undefined;
  readonly adopt?: (tokens: T | undefined) => void;
}

/**
 * Serializes OAuth token grants for one credential identity in this process.
 *
 * The SDK performs its token-endpoint fetch before calling `saveTokens` or
 * `invalidateCredentials`. This transaction joins those two phases so a late
 * SDK callback cannot overwrite or delete a newer durable winner.
 */
export class OAuthTokenTransaction<T extends object> {
  private readonly effects: Effect<T>[] = [];

  constructor(private readonly options: OAuthTokenTransactionOptions<T>) {}

  createFetch(fetchFn: typeof fetch = globalThis.fetch): typeof fetch {
    return (async (input, init) => {
      const params = init?.body instanceof URLSearchParams ? init.body : undefined;
      const grantType = params?.get('grant_type');
      if (
        params === undefined ||
        (grantType !== 'refresh_token' && grantType !== 'authorization_code')
      ) {
        return fetchFn(input, init);
      }
      return transactionLock.runExclusive(this.options.key, () =>
        this.runTokenRequest(fetchFn, input, init, params, grantType),
      );
    }) as typeof fetch;
  }

  async save(tokens: T): Promise<void> {
    await transactionLock.runExclusive(this.options.key, async () => {
      if (this.consumeSave(tokens)) {
        this.adopt(await this.options.read());
        return;
      }
      await this.options.write(tokens);
      this.adopt(tokens);
    });
  }

  async invalidateFromSdk(scope: 'tokens' | 'all'): Promise<boolean> {
    return transactionLock.runExclusive(this.options.key, async () => {
      const effect = this.takeInvalidate(scope);
      if (effect === undefined) return false;
      const current = await this.options.read();
      if (effect.preserveCurrent) {
        this.adopt(current);
        return false;
      }
      if (effect.grantType === 'authorization_code' && effect.error === 'invalid_grant') {
        this.adopt(current);
        return false;
      }
      if (effect.alreadyRemoved) return current === undefined;
      if (!isDeepStrictEqual(current, effect.tokensAtFailure)) {
        this.adopt(current);
        return false;
      }
      await this.options.remove();
      this.adopt(undefined);
      return true;
    });
  }

  async clear(): Promise<void> {
    await transactionLock.runExclusive(this.options.key, async () => {
      await this.options.remove();
      this.adopt(undefined);
    });
  }

  private async runTokenRequest(
    fetchFn: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] | undefined,
    params: URLSearchParams,
    grantType: GrantType,
  ): Promise<Response> {
    const requestedRefreshToken =
      grantType === 'refresh_token' ? (params.get('refresh_token') ?? undefined) : undefined;
    if (grantType === 'refresh_token') {
      const winner = await this.resolveRefreshWinner(requestedRefreshToken);
      if (winner !== undefined) return winner;
    }

    const response = await fetchFn(input, {
      ...init,
      signal:
        init?.signal === undefined || init.signal === null
          ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          : AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (grantType === 'refresh_token') {
      const winner = await this.resolveRefreshWinner(requestedRefreshToken);
      if (winner !== undefined) return winner;
    }
    if (!response.ok) {
      const error = await oauthErrorCode(response);
      if (
        error === 'invalid_grant' ||
        error === 'invalid_client' ||
        error === 'unauthorized_client'
      ) {
        const current = await this.options.read();
        const alreadyRemoved =
          grantType === 'refresh_token' &&
          error === 'invalid_grant' &&
          refreshToken(current) === requestedRefreshToken;
        if (alreadyRemoved) {
          await this.options.remove();
          this.adopt(undefined);
        }
        this.remember({
          kind: 'invalidate',
          grantType,
          error,
          tokensAtFailure: current,
          alreadyRemoved,
          preserveCurrent: false,
        });
      }
      return response;
    }

    const payload: unknown = await response.clone().json().catch(() => undefined);
    const parsed = this.options.parse(payload);
    if (parsed === undefined) return response;
    const tokens =
      grantType === 'refresh_token' && refreshToken(parsed) === undefined
        ? (this.options.parse({ ...parsed, refresh_token: requestedRefreshToken }) ?? parsed)
        : parsed;
    await this.options.write(tokens);
    this.adopt(tokens);
    this.remember({ kind: 'save', tokens });
    return response;
  }

  private async resolveRefreshWinner(requested: string | undefined): Promise<Response | undefined> {
    const current = await this.options.read();
    this.adopt(current);
    const currentRefreshToken = refreshToken(current);
    if (currentRefreshToken === requested) return undefined;
    if (current === undefined || currentRefreshToken === undefined) {
      this.remember({
        kind: 'invalidate',
        grantType: 'refresh_token',
        error: 'invalid_grant',
        tokensAtFailure: current,
        alreadyRemoved: current === undefined,
        preserveCurrent: current !== undefined,
      });
      return jsonResponse({ error: 'invalid_grant' }, 400);
    }
    this.remember({ kind: 'save', tokens: current });
    return jsonResponse(current);
  }

  private adopt(tokens: T | undefined): void {
    this.options.adopt?.(tokens);
  }

  private remember(effect: Effect<T>): void {
    this.effects.push(effect);
  }

  private consumeSave(tokens: T): boolean {
    const index = this.effects.findIndex(
      (effect) => effect.kind === 'save' && isDeepStrictEqual(effect.tokens, tokens),
    );
    if (index === -1) return false;
    this.effects.splice(index, 1);
    return true;
  }

  private takeInvalidate(scope: 'tokens' | 'all'): Extract<Effect<T>, { kind: 'invalidate' }> | undefined {
    const index = this.effects.findIndex(
      (effect) =>
        effect.kind === 'invalidate' &&
        (scope === 'tokens'
          ? effect.error === 'invalid_grant'
          : effect.error === 'invalid_client' || effect.error === 'unauthorized_client'),
    );
    if (index === -1) return undefined;
    return this.effects.splice(index, 1)[0] as Extract<Effect<T>, { kind: 'invalidate' }>;
  }
}

function refreshToken(tokens: object | undefined): string | undefined {
  if (tokens === undefined || !('refresh_token' in tokens)) return undefined;
  return typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined;
}

async function oauthErrorCode(response: Response): Promise<string | undefined> {
  const payload: unknown = await response.clone().json().catch(() => undefined);
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return undefined;
  return typeof payload.error === 'string' ? payload.error : undefined;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class TransactionLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const transactionLock = new TransactionLock();
