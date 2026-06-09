/**
 * `OAuthService` — implementation of `IOAuthService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';
import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  type DeviceAuthorization,
} from '@moonshot-ai/kimi-code-oauth';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

import { IEnvironmentService } from '../environment/environment';
import { IOAuthService } from './oauth';

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly deviceAuth: DeviceAuthorization;
  /** Resolved seconds-until-expiry (may differ from `deviceAuth.expiresIn` if that was null). */
  readonly expiresInSec: number;
  readonly startedAt: number;
  readonly expiresAt: number;
  status: OAuthFlowStatus;
  readonly controller: AbortController;
  resolvedAt?: number;
  errorMessage?: string;
  gcTimer?: NodeJS.Timeout;
}

/** Terminal flows live this long after resolution before GC. */
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

export class OAuthService extends Disposable implements IOAuthService {
  readonly _serviceBrand: undefined;

  private readonly _authFacade: KimiAuthFacade;
  private readonly _flows = new Map<string, FlowState>();

  constructor(@IEnvironmentService private readonly env: IEnvironmentService) {
    super();
    this._authFacade = new KimiAuthFacade({
      homeDir: env.homeDir,
      configPath: env.configPath,
    });
  }

  /** @internal Test-only factory that injects a mock facade. */
  static _createForTest(env: IEnvironmentService, facade: KimiAuthFacade): OAuthService {
    const svc = new (OAuthService as any)(env) as OAuthService;
    (svc as any)._authFacade = facade;
    return svc;
  }

  async startLogin(providerName?: string): Promise<OAuthFlowStart> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;

    // Supersede any existing pending flow.
    const existing = this._flows.get(name);
    if (existing !== undefined && existing.status === 'pending') {
      existing.controller.abort();
      this._setTerminal(existing, 'cancelled');
    }

    const flowId = `oauth_${ulid()}`;
    const controller = new AbortController();

    // Capture the device authorization via a deferred. `KimiAuthFacade.login`
    // calls `onDeviceCode` exactly once, then starts polling. We resolve the
    // deferred from inside the callback so this method can return as soon as
    // the URLs are known — well before the polling completes.
    let resolveAuth: (d: DeviceAuthorization) => void;
    let rejectAuth: (e: unknown) => void;
    const authPromise = new Promise<DeviceAuthorization>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    });

    // Background login — DO NOT await. We hand the controller's signal in so
    // `cancelLogin()` and the supersede path can interrupt mid-poll.
    const loginPromise = this._authFacade.login(name, {
      signal: controller.signal,
      onDeviceCode: (auth) => {
        resolveAuth(auth);
      },
    });

    // Surface a synchronous failure (device-auth request itself fails before
    // `onDeviceCode` fires) by racing the login promise.
    loginPromise.catch((err) => {
      rejectAuth(err);
    });

    let deviceAuth: DeviceAuthorization;
    try {
      deviceAuth = await authPromise;
    } catch (err) {
      // The OAuth host or the network broke before we got a device code.
      // No flow state was registered yet; just surface the error to the
      // REST handler → 50001.
      const msg = err instanceof Error ? err.message : String(err);
      throw new OAuthError(`failed to start device flow: ${msg}`);
    }

    const startedAt = Date.now();
    // `expiresIn` is server-reported and may be null (RFC 8628 §3.2 allows
    // omission). Fall back to the local 15-min budget enforced by
    // `OAuthManager.login`, so the `expires_at` we surface to clients is
    // never further out than the deadline that's actually being enforced.
    const expiresInSec = deviceAuth.expiresIn ?? 15 * 60;
    const state: FlowState = {
      flowId,
      provider: name,
      deviceAuth,
      expiresInSec,
      startedAt,
      expiresAt: startedAt + expiresInSec * 1000,
      status: 'pending',
      controller,
    };
    this._flows.set(name, state);

    // Wire the background promise's terminal transition. We branch on error
    // class + message — see the file header for the mapping.
    loginPromise.then(
      () => this._handleSuccess(state),
      (err) => this._handleFailure(state, err),
    );

    return {
      flow_id: flowId,
      provider: name,
      verification_uri: deviceAuth.verificationUri,
      verification_uri_complete: deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri,
      user_code: deviceAuth.userCode,
      expires_in: expiresInSec,
      interval: deviceAuth.interval,
      status: 'pending',
      expires_at: new Date(state.expiresAt).toISOString(),
    };
  }

  getFlow(providerName?: string): OAuthFlowSnapshot | undefined {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const state = this._flows.get(name);
    if (state === undefined) return undefined;
    return this._toSnapshot(state);
  }

  async cancelLogin(providerName?: string): Promise<OAuthLoginCancelResponse> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const state = this._flows.get(name);
    if (state === undefined) {
      // No flow at all → treat as "already cancelled" (idempotent).
      return { cancelled: false, status: 'cancelled' };
    }
    if (state.status !== 'pending') {
      return { cancelled: false, status: state.status };
    }
    state.controller.abort();
    this._setTerminal(state, 'cancelled');
    return { cancelled: true, status: 'cancelled' };
  }

  async logout(providerName?: string): Promise<OAuthLogoutResponse> {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    // Also cancel any in-flight flow so the next `GET /v1/auth` sees a clean
    // slate.
    const pending = this._flows.get(name);
    if (pending !== undefined && pending.status === 'pending') {
      pending.controller.abort();
      this._setTerminal(pending, 'cancelled');
    }
    const result = await this._authFacade.logout(name);
    return { logged_out: true, provider: result.providerName };
  }

  override dispose(): void {
    if (this._isDisposed) return;
    for (const state of this._flows.values()) {
      if (state.gcTimer !== undefined) clearTimeout(state.gcTimer);
      if (state.status === 'pending') {
        try {
          state.controller.abort();
        } catch {
          // ignore
        }
      }
    }
    this._flows.clear();
    super.dispose();
  }

  /* ----------------------------- internals ---------------------------- */

  private _handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return; // already cancelled / superseded
    this._setTerminal(state, 'authenticated');
  }

  private _handleFailure(state: FlowState, err: unknown): void {
    if (state.status !== 'pending') return; // already cancelled / superseded

    const status = classifyFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    state.errorMessage = message;
    this._setTerminal(state, status);
  }

  private _setTerminal(state: FlowState, status: OAuthFlowStatus): void {
    if (state.status === status) return;
    state.status = status;
    state.resolvedAt = Date.now();
    // Schedule GC. If a new flow supersedes this entry first, the new flow
    // replaces the map entry and this timer just no-ops on the stale state.
    if (state.gcTimer !== undefined) clearTimeout(state.gcTimer);
    state.gcTimer = setTimeout(() => {
      const current = this._flows.get(state.provider);
      // Only GC if this state IS the current map entry. A newer flow may
      // have already overwritten the slot.
      if (current === state) this._flows.delete(state.provider);
    }, TERMINAL_RETENTION_MS);
    // Don't keep the process alive solely for GC.
    state.gcTimer.unref?.();
  }

  private _toSnapshot(state: FlowState): OAuthFlowSnapshot {
    const snap: OAuthFlowSnapshot = {
      flow_id: state.flowId,
      provider: state.provider,
      status: state.status,
      verification_uri: state.deviceAuth.verificationUri,
      verification_uri_complete:
        state.deviceAuth.verificationUriComplete ?? state.deviceAuth.verificationUri,
      user_code: state.deviceAuth.userCode,
      expires_in: state.expiresInSec,
      expires_at: new Date(state.expiresAt).toISOString(),
      interval: state.deviceAuth.interval,
    };
    if (state.resolvedAt !== undefined) {
      (snap as { resolved_at?: string }).resolved_at = new Date(
        state.resolvedAt,
      ).toISOString();
    }
    if (state.errorMessage !== undefined) {
      (snap as { error_message?: string }).error_message = state.errorMessage;
    }
    return snap;
  }
}

/**
 * Map the error thrown by the background login promise to a terminal status.
 *
 * - `DeviceCodeTimeoutError` → 'expired' (the 15-min budget ran out)
 * - `OAuthError` whose message starts with 'Login aborted' → 'cancelled'
 *   (our own AbortController fired or the toolkit's signal path)
 * - `OAuthError` mentioning 'denied' → 'denied' (user refused)
 * - Anything else → 'denied' (we collapse "denied" and "generic failure";
 *   the `error_message` field carries the diagnostic detail for the UI)
 */
function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return 'expired';
  if (err instanceof OAuthError) {
    const msg = err.message.toLowerCase();
    if (msg.includes('aborted')) return 'cancelled';
    if (msg.includes('denied')) return 'denied';
    return 'denied';
  }
  return 'denied';
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected (@IEnvironmentService only); `staticArguments = []`.
// `supportsDelayedInstantiation = false` preserves current reverse-dispose
// semantics.
registerSingleton(IOAuthService, OAuthService, InstantiationType.Delayed);
