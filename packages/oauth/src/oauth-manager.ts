/**
 * OAuthManager — per-provider token lifecycle (load / refresh / login / logout).
 *
 *  - Lazy refresh on `ensureFresh()` — no background loop
 *  - Single-process concurrency: in-memory mutex serialises refreshes
 *  - Multi-process coordination: before + after storage re-read, so a
 *    concurrent refresh from another CLI process is detected (best-effort)
 *  - `login()`: device code flow with a 15 min local timeout
 *  - `logout()`: delete stored token
 *
 * All network / clock / storage operations are injectable for tests.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { DeviceCodeTimeoutError, OAuthError, OAuthUnauthorizedError } from './errors';
import { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from './oauth';
import type { DevicePollResult, RefreshOptions } from './oauth';
import type { TokenStorage } from './storage';
import { classifyToken, revokedTombstone, type TokenState } from './token-state';
import type { DeviceAuthorization, DeviceHeaders, OAuthFlowConfig, TokenInfo } from './types';

const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const REFRESH_THRESHOLD_RATIO = 0.5;
const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;

export function defaultRefreshThreshold(expiresIn: number): number {
  if (expiresIn > 0) {
    return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO);
  }
  return MIN_REFRESH_THRESHOLD_SECONDS;
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
type ManagerRefreshOptions = Omit<RefreshOptions, 'deviceHeaders'>;

export type OAuthRefreshOutcome =
  | { readonly success: true }
  | { readonly success: false; readonly reason: 'unauthorized' | 'network_or_other' };

export interface OAuthManagerOptions {
  readonly config: OAuthFlowConfig;
  readonly storage: TokenStorage;
  readonly refreshThreshold?: ((expiresIn: number) => number) | undefined;
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: Sleep | undefined;
  /** Observer invoked synchronously when a refresh attempt resolves. */
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly refreshTokenImpl?:
    | ((
        config: OAuthFlowConfig,
        refreshToken: string,
        options?: ManagerRefreshOptions,
      ) => Promise<TokenInfo>)
    | undefined;
  readonly requestDeviceImpl?:
    | ((config: OAuthFlowConfig) => Promise<DeviceAuthorization>)
    | undefined;
  readonly pollDeviceImpl?:
    | ((config: OAuthFlowConfig, deviceCode: string) => Promise<DevicePollResult>)
    | undefined;
  readonly deviceHeaders?: (() => DeviceHeaders | undefined) | undefined;
  /**
   * Root directory for per-provider lock files; resolves to
   * `{configDir}/oauth/{providerName}.lock`.
   *
   * **Production callers MUST pass this explicitly** (KimiCoreClient /
   * session-manager wire it through from the resolved config root). A
   * missing `configDir` disables the cross-process lock entirely, so
   * silently falling back to an env var in production would mask a
   * genuine mis-wiring.
   *
   * When omitted AND `process.env.NODE_ENV === 'test'`, the manager
   * falls back to `process.env.KIMI_CODE_HOME` so multi-process test
   * harnesses don't need to thread the dir through every fixture. In
   * production the fallback is inert. Windows platforms and
   * `process.env.KIMI_DISABLE_OAUTH_LOCK === '1'` always skip; the
   * "re-read storage" fail-safe remains as a best-effort coordinator.
   */
  readonly configDir?: string | undefined;
}

export interface LoginOptions {
  readonly onDeviceCode?: ((auth: DeviceAuthorization) => Promise<void> | void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class OAuthManager {
  private readonly config: OAuthFlowConfig;
  private readonly storage: TokenStorage;
  private readonly refreshThresholdFn: (expiresIn: number) => number;
  private readonly deviceCodeTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly refreshImpl: NonNullable<OAuthManagerOptions['refreshTokenImpl']>;
  private readonly requestImpl: NonNullable<OAuthManagerOptions['requestDeviceImpl']>;
  private readonly pollImpl: NonNullable<OAuthManagerOptions['pollDeviceImpl']>;
  private readonly deviceHeaders: (() => DeviceHeaders | undefined) | undefined;
  private readonly configDir: string | undefined;
  private readonly onRefresh: ((outcome: OAuthRefreshOutcome) => void) | undefined;

  /**
   * In-flight refresh coalescer: one refresh per ensureFresh race.
   *
   * Tracks the `force` flag of the in-flight call so a later `force=true`
   * caller cannot piggyback a non-force result that may short-circuit on
   * a still-cached token. A non-force caller is happy with any settled
   * outcome and may piggyback either kind.
   */
  private inFlightRefresh: { promise: Promise<string>; force: boolean } | undefined;

  constructor(options: OAuthManagerOptions) {
    this.config = options.config;
    this.storage = options.storage;
    this.refreshThresholdFn = options.refreshThreshold ?? defaultRefreshThreshold;
    this.deviceCodeTimeoutMs = options.deviceCodeTimeoutMs ?? DEFAULT_DEVICE_CODE_TIMEOUT_MS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = options.sleep ?? defaultSleep;
    this.deviceHeaders = options.deviceHeaders;
    this.onRefresh = options.onRefresh;
    this.refreshImpl =
      options.refreshTokenImpl ??
      ((config, refreshToken, refreshOptions) =>
        refreshAccessToken(config, refreshToken, {
          ...refreshOptions,
          deviceHeaders: this.resolveDeviceHeaders(),
        }));
    this.requestImpl =
      options.requestDeviceImpl ??
      ((config) =>
        requestDeviceAuthorization(config, {
          deviceHeaders: this.resolveDeviceHeaders(),
        }));
    this.pollImpl =
      options.pollDeviceImpl ??
      ((config, deviceCode) =>
        pollDeviceToken(config, deviceCode, {
          deviceHeaders: this.resolveDeviceHeaders(),
        }));
    // The `KIMI_CODE_HOME` fallback MUST stay test-only so production
    // entry points can't silently run without a lock just because the
    // env happens to be unset. vitest sets `NODE_ENV='test'` by default,
    // so multi-process test workers still pick up the test home path.
    const envConfigDir =
      process.env['NODE_ENV'] === 'test' ? process.env['KIMI_CODE_HOME'] : undefined;
    this.configDir = options.configDir ?? envConfigDir;
  }

  private resolveDeviceHeaders(): DeviceHeaders | undefined {
    return this.deviceHeaders?.();
  }

  private async loadState(): Promise<TokenState> {
    return classifyToken(await this.storage.load(this.config.name));
  }

  private notifyRefresh(outcome: OAuthRefreshOutcome): void {
    if (this.onRefresh === undefined) return;
    try {
      this.onRefresh(outcome);
    } catch {
      // Observer must not affect OAuth flow.
    }
  }

  /**
   * Resolve the sentinel target file `proper-lockfile` locks against.
   * `proper-lockfile.lock(target)` creates `${target}.lock` as the
   * actual lock directory, so the real lockfile on disk ends up at
   * `{configDir}/oauth/{providerName}.lock`. Returns `undefined` when
   * locking is opted out (no configDir, Windows, env kill switch).
   */
  private resolveLockTarget(): string | undefined {
    if (process.platform === 'win32') return undefined;
    if (process.env['KIMI_DISABLE_OAUTH_LOCK'] === '1') return undefined;
    if (this.configDir === undefined) return undefined;
    return `${this.configDir}/oauth/${this.config.name}`;
  }

  /**
   * Acquire the cross-process lock around the refresh critical section.
   * Returns a `release` closure; when locking is disabled returns a no-op.
   * If locking is configured but cannot be acquired, fail closed rather than
   * refreshing with no lock and racing refresh_token rotation.
   */
  private async acquireRefreshLock(): Promise<() => Promise<void>> {
    const target = this.resolveLockTarget();
    if (target === undefined) return async () => {};

    // proper-lockfile requires the target path to exist. We create
    // an empty sentinel file; the real lock indicator is the sibling
    // `{target}.lock` directory proper-lockfile creates and cleans
    // up on release (→ test oracle `{configDir}/oauth/{name}.lock`
    // must be absent after a graceful exit).
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', { flag: 'a' });
    } catch (error) {
      throw new OAuthError(
        `Unable to prepare OAuth refresh lock for "${this.config.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      const release = await lockfile.lock(target, {
        retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1_000 },
        stale: 5_000,
        realpath: false,
      });
      return async () => {
        try {
          await release();
        } catch {
          /* ignore release-after-stale */
        }
      };
    } catch (error) {
      throw new OAuthError(
        `Unable to acquire OAuth refresh lock for "${this.config.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async hasToken(): Promise<boolean> {
    return (await this.loadState()).kind === 'valid';
  }

  async getCachedAccessToken(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.kind === 'valid' ? state.token.accessToken : undefined;
  }

  async logout(): Promise<void> {
    await this.storage.remove(this.config.name);
  }

  /**
   * Return a valid access_token, refreshing if within the dynamic threshold.
   * Throws if no token is persisted (caller should invoke `/login`).
   */
  async ensureFresh(options: { force?: boolean } = {}): Promise<string> {
    const force = options.force === true;
    const current = this.inFlightRefresh;
    if (current !== undefined) {
      // A non-force caller is happy with whatever the in-flight call
      // settles to. A force caller can also piggyback another force
      // call. Only force-on-top-of-non-force needs its own refresh,
      // because the non-force call may return a still-cached token
      // that doesn't satisfy the caller-requested forced rotation.
      if (!force || current.force) {
        return current.promise;
      }
      // Wait for the non-force call to settle (success or failure),
      // then start our own forced refresh. Swallowing rejection here
      // is safe: the non-force caller already owns surfacing that error.
      return current.promise.catch(() => undefined).then(() => this.ensureFresh(options));
    }

    const promise = this.doEnsureFresh(force).finally(() => {
      // Only clear our own slot. A later, replacement in-flight (e.g. a
      // queued force after this non-force resolves) must not be evicted
      // by our cleanup.
      if (this.inFlightRefresh?.promise === promise) {
        this.inFlightRefresh = undefined;
      }
    });
    this.inFlightRefresh = { promise, force };
    return promise;
  }

  private async doEnsureFresh(force: boolean): Promise<string> {
    const initial = await this.loadState();
    switch (initial.kind) {
      case 'missing':
        throw new OAuthUnauthorizedError(
          `No token for "${this.config.name}". Run /login to authenticate.`,
        );
      case 'revoked':
        // A prior 401 (possibly from another process) tombstoned this token.
        // Surface as unauthorized so callers route into the re-login flow
        // instead of treating it as a transient error.
        throw new OAuthUnauthorizedError(
          `Stored token for "${this.config.name}" was rejected; re-login required.`,
        );
      case 'valid':
        break;
    }
    const token = initial.token;

    const needRefresh = this.shouldRefreshToken(token, force);
    if (!needRefresh) {
      return token.accessToken;
    }

    // Acquire the cross-process lock before entering the refresh critical
    // section. Concurrent CLI processes serialise on
    // `{configDir}/oauth/{providerName}.lock` via `proper-lockfile`.
    // Post-acquire we re-read storage: if a peer already rotated the
    // token, short-circuit and return theirs instead of burning an
    // extra refresh.
    const release = await this.acquireRefreshLock();
    try {
      // Post-lock re-read. The semantics:
      //
      //   • force=false: the normal threshold short-circuit still
      //     applies.
      //   • force=true: still refresh unless storage changed while we
      //     waited for the lock. That preserves caller-requested forced
      //     refreshes for unchanged tokens while coalescing real peer
      //     refreshes across processes.
      const afterLock = await this.loadState();
      let activeToken: TokenInfo;
      switch (afterLock.kind) {
        case 'revoked':
          // Peer process tombstoned the file while we waited for the lock.
          throw new OAuthUnauthorizedError(
            `Stored token for "${this.config.name}" was rejected; re-login required.`,
          );
        case 'missing':
          // File disappeared (e.g. logout from another process) while we
          // waited for the lock; fall back to the snapshot we read pre-lock.
          activeToken = token;
          break;
        case 'valid': {
          const after = afterLock.token;
          if (!this.shouldRefreshToken(after, force)) {
            return after.accessToken;
          }
          if (force) {
            const changedWhileWaiting =
              after.refreshToken !== token.refreshToken ||
              after.accessToken !== token.accessToken ||
              after.expiresAt !== token.expiresAt ||
              after.expiresIn !== token.expiresIn;
            if (changedWhileWaiting) {
              return after.accessToken;
            }
          }
          activeToken = after;
          break;
        }
      }

      if (activeToken.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError(
          `Token for "${this.config.name}" has no refresh_token; re-login required.`,
        );
      }

      try {
        const refreshed = await this.refreshImpl(this.config, activeToken.refreshToken);
        await this.storage.save(this.config.name, refreshed);
        this.notifyRefresh({ success: true });
        return refreshed.accessToken;
      } catch (error) {
        if (error instanceof OAuthUnauthorizedError) {
          // 401/403 might mean (a) refresh_token genuinely revoked or
          // (b) another process rotated the refresh_token while we were
          // mid-flight. Check (b) first: re-read storage, and if a peer
          // wrote a different valid refresh_token, treat the 401 as a
          // stale-token race and use the rotated value.
          await this.sleep(100);
          const recovery = await this.loadState();
          if (
            recovery.kind === 'valid' &&
            recovery.token.refreshToken !== activeToken.refreshToken
          ) {
            this.notifyRefresh({ success: true });
            return recovery.token.accessToken;
          }
          // No peer rotated — record the rejection on disk as a tombstone so
          // a fresh process (with no in-memory state) won't re-attempt the
          // same dead refresh_token. The file stays present so peers see
          // "previously logged in, now rejected" instead of "never logged in".
          await this.storage.save(this.config.name, revokedTombstone(activeToken));
          this.notifyRefresh({ success: false, reason: 'unauthorized' });
        } else {
          this.notifyRefresh({ success: false, reason: 'network_or_other' });
        }
        throw error;
      }
    } finally {
      await release();
    }
  }

  /**
   * Drive the device code flow end-to-end. `onDeviceCode` is called once
   * the user code is available so the caller can display it.
   *
   * Local 15-min wall-clock budget guards against forever-pending flows.
   */
  async login(options: LoginOptions = {}): Promise<TokenInfo> {
    const startedAt = this.now();
    const deadlineAt = startedAt + Math.ceil(this.deviceCodeTimeoutMs / 1000);

    while (true) {
      const auth = await this.requestImpl(this.config);
      await options.onDeviceCode?.(auth);

      // RFC 8628 §3.5: clients must add at least 5s on `slow_down` and
      // continue polling at the increased interval thereafter.
      let currentInterval = Math.max(auth.interval, 1);
      // Poll until success, denial, local timeout, or expired_token (retry outer).
      let deviceExpired = false;
      while (true) {
        this.throwIfAborted(options.signal);
        if (this.now() >= deadlineAt) {
          throw new DeviceCodeTimeoutError(
            `Device authorization timed out after ${Math.ceil(this.deviceCodeTimeoutMs / 1000)}s`,
          );
        }

        const result = await this.pollImpl(this.config, auth.deviceCode);
        if (result.kind === 'success') {
          await this.storage.save(this.config.name, result.token);
          return result.token;
        }
        if (result.kind === 'denied') {
          throw new OAuthError(
            `Authorization denied${result.description ? `: ${result.description}` : ''}`,
          );
        }
        if (result.kind === 'expired') {
          deviceExpired = true;
          break;
        }
        // pending: bump interval permanently when server requests slow_down.
        if (result.errorCode === 'slow_down') {
          currentInterval += 5;
        }
        await this.sleep(currentInterval * 1000);
      }
      if (!deviceExpired) break;
      // Otherwise loop outer to request a new device code.
      // Guard: if we're already past the deadline, bail.
      if (this.now() >= deadlineAt) {
        throw new DeviceCodeTimeoutError('Device authorization timed out');
      }
    }

    // Unreachable — inner loop always returns or throws.
    throw new OAuthError('Device flow ended unexpectedly');
  }

  private shouldRefreshToken(token: TokenInfo, force: boolean): boolean {
    if (force) return true;
    if (token.expiresAt === 0) return false;
    const remaining = token.expiresAt - this.now();
    return remaining < this.refreshThresholdFn(token.expiresIn);
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new OAuthError('Login aborted by caller');
    }
  }
}

/**
 * Generate a synthetic OAuth client instance id. Used by `/login` to
 * correlate device flows with the CLI instance without depending on
 * runtime state. Not required by the protocol — purely for diagnostics.
 */
export function newInstanceId(): string {
  return randomUUID();
}
