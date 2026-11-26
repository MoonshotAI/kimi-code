import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { DeviceCodeTimeoutError, OAuthAccessDeniedError, OAuthError, OAuthUnauthorizedError } from './errors';
import type { WorkspaceTarget } from './managed-workspaces';
import {
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
  switchWorkspaceToken,
} from './oauth';
import type { DevicePollResult, RefreshOptions } from './oauth';
import type { TokenStorage } from './storage';
import { classifyToken, revokedTombstone, type TokenState } from './token-state';
import type { DeviceAuthorization, OAuthFlowConfig, OAuthRequestHeaders, TokenInfo } from './types';

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
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly refreshTokenImpl?:
    | ((
        config: OAuthFlowConfig,
        refreshToken: string,
        options?: ManagerRefreshOptions,
      ) => Promise<TokenInfo>)
    | undefined;
  readonly switchWorkspaceImpl?:
    | ((
        config: OAuthFlowConfig,
        refreshToken: string,
        target: WorkspaceTarget,
        options?: ManagerRefreshOptions,
      ) => Promise<TokenInfo>)
    | undefined;
  readonly requestDeviceImpl?:
    | ((config: OAuthFlowConfig) => Promise<DeviceAuthorization>)
    | undefined;
  readonly pollDeviceImpl?:
    | ((config: OAuthFlowConfig, deviceCode: string) => Promise<DevicePollResult>)
    | undefined;
  readonly deviceHeaders?: (() => OAuthRequestHeaders | undefined) | undefined;
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
  private readonly switchImpl: NonNullable<OAuthManagerOptions['switchWorkspaceImpl']>;
  private readonly requestImpl: NonNullable<OAuthManagerOptions['requestDeviceImpl']>;
  private readonly pollImpl: NonNullable<OAuthManagerOptions['pollDeviceImpl']>;
  private readonly deviceHeaders: (() => OAuthRequestHeaders | undefined) | undefined;
  private readonly configDir: string | undefined;
  private readonly onRefresh: ((outcome: OAuthRefreshOutcome) => void) | undefined;

  private inFlightRefresh: { promise: Promise<string>; force: boolean } | undefined;
  private inFlightSwitch: Promise<TokenInfo> | undefined;

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
    this.switchImpl =
      options.switchWorkspaceImpl ??
      ((config, refreshToken, target, refreshOptions) =>
        switchWorkspaceToken(config, refreshToken, target, {
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
    const envConfigDir =
      process.env['NODE_ENV'] === 'test' ? process.env['KIMI_CODE_HOME'] : undefined;
    this.configDir = options.configDir ?? envConfigDir;
  }

  private resolveDeviceHeaders(): OAuthRequestHeaders | undefined {
    return this.deviceHeaders?.();
  }

  private async loadState(): Promise<TokenState> {
    return classifyToken(await this.storage.load(this.config.name));
  }

  private notifyRefresh(outcome: OAuthRefreshOutcome): void {
    if (this.onRefresh === undefined) return;
    try {
      this.onRefresh(outcome);
    } catch {}
  }

  private resolveLockTarget(): string | undefined {
    if (process.platform === 'win32') return undefined;
    if (process.env['KIMI_DISABLE_OAUTH_LOCK'] === '1') return undefined;
    if (this.configDir === undefined) return undefined;
    return `${this.configDir}/oauth/${this.config.name}`;
  }

  private async acquireRefreshLock(): Promise<() => Promise<void>> {
    const target = this.resolveLockTarget();
    if (target === undefined) return async () => {};

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
        } catch {}
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

  async ensureFresh(options: { force?: boolean } = {}): Promise<string> {
    if (this.inFlightSwitch !== undefined) {
      return this.inFlightSwitch.catch(() => undefined).then(() => this.ensureFresh(options));
    }
    const force = options.force === true;
    const current = this.inFlightRefresh;
    if (current !== undefined) {
      if (!force || current.force) {
        return current.promise;
      }
      return current.promise.catch(() => undefined).then(() => this.ensureFresh(options));
    }

    const promise = this.doEnsureFresh(force).finally(() => {
      if (this.inFlightRefresh?.promise === promise) {
        this.inFlightRefresh = undefined;
      }
    });
    this.inFlightRefresh = { promise, force };
    return promise;
  }

  async switchWorkspace(target: WorkspaceTarget): Promise<TokenInfo> {
    const prior = this.inFlightSwitch ?? this.inFlightRefresh?.promise;
    const run = (
      prior === undefined ? this.doSwitchWorkspace(target) : prior.catch(() => undefined).then(() => this.doSwitchWorkspace(target))
    ).finally(() => {
      if (this.inFlightSwitch === run) {
        this.inFlightSwitch = undefined;
      }
    });
    this.inFlightSwitch = run;
    return run;
  }

  private async doSwitchWorkspace(target: WorkspaceTarget): Promise<TokenInfo> {
    const release = await this.acquireRefreshLock();
    try {
      const state = await this.loadState();
      switch (state.kind) {
        case 'missing':
          throw new OAuthUnauthorizedError(
            `No token for "${this.config.name}". Run /login to authenticate.`,
          );
        case 'revoked':
          throw new OAuthUnauthorizedError(
            `Stored token for "${this.config.name}" was rejected; re-login required.`,
          );
        case 'valid':
          break;
      }
      if (state.token.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError(
          `Token for "${this.config.name}" has no refresh_token; re-login required.`,
        );
      }
      const switched = await this.switchImpl(this.config, state.token.refreshToken, target);
      await this.storage.save(this.config.name, switched);
      this.notifyRefresh({ success: true });
      return switched;
    } finally {
      await release();
    }
  }

  private async doEnsureFresh(force: boolean): Promise<string> {
    const initial = await this.loadState();
    switch (initial.kind) {
      case 'missing':
        throw new OAuthUnauthorizedError(
          `No token for "${this.config.name}". Run /login to authenticate.`,
        );
      case 'revoked':
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

    const release = await this.acquireRefreshLock();
    try {
      const afterLock = await this.loadState();
      let activeToken: TokenInfo;
      switch (afterLock.kind) {
        case 'revoked':
          throw new OAuthUnauthorizedError(
            `Stored token for "${this.config.name}" was rejected; re-login required.`,
          );
        case 'missing':
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
          await this.sleep(100);
          const recovery = await this.loadState();
          if (
            recovery.kind === 'valid' &&
            recovery.token.refreshToken !== activeToken.refreshToken
          ) {
            this.notifyRefresh({ success: true });
            return recovery.token.accessToken;
          }
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

  async login(options: LoginOptions = {}): Promise<TokenInfo> {
    const startedAt = this.now();
    const deadlineAt = startedAt + Math.ceil(this.deviceCodeTimeoutMs / 1000);

    while (true) {
      const auth = await this.requestImpl(this.config);
      await options.onDeviceCode?.(auth);

      let currentInterval = Math.max(auth.interval, 1);
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
          throw new OAuthAccessDeniedError(
            `Authorization denied${result.description ? `: ${result.description}` : ''}`,
          );
        }
        if (result.kind === 'expired') {
          deviceExpired = true;
          break;
        }
        if (result.errorCode === 'slow_down') {
          currentInterval += 5;
        }
        await this.sleep(currentInterval * 1000);
      }
      if (!deviceExpired) break;
      if (this.now() >= deadlineAt) {
        throw new DeviceCodeTimeoutError('Device authorization timed out');
      }
    }

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

export function newInstanceId(): string {
  return randomUUID();
}
