/**
 * `IOAuthService` — daemon-facing device-code login orchestration.
 *
 * Bridges the OAuth toolkit's `login({onDeviceCode})` callback shape to a
 * REST resource: the frontend POSTs to start, gets a `verification_uri`
 * synchronously, then polls a GET endpoint for status transitions while the
 * daemon polls the OAuth host in the background.
 *
 * **One in-flight flow per provider**. A second start cancels
 * the existing pending flow first (transitions it to `'cancelled'`) then
 * mints a fresh `flow_id`. Completed flows live in-memory for 5 min so the
 * frontend's last poll lands on the terminal status; after that, they GC
 * and `getFlow()` returns `undefined`.
 *
 * **No client coupling**. Daemon does NOT detect frontend exit
 * / WS disconnect. Cleanup paths:
 *   1. 15-min upstream timeout (DeviceCodeTimeoutError → 'expired')
 *   2. Explicit `cancelLogin()` (→ 'cancelled')
 *   3. Same-provider new flow superseding (→ 'cancelled')
 *
 * **Token + config** land via the toolkit's provisioning path: on success,
 * the `managed:kimi-code` provider + models entry are written to
 * `config.toml`, and the cached token is saved to credentials. Frontend
 * follow-up: hit `GET /v1/auth` to confirm `ready: true`.
 *
 * **Architecture**:
 *
 *   POST /v1/oauth/login
 *     │
 *     ▼
 *   startLogin()  ──┐
 *                   │  managed auth facade login runs in BACKGROUND
 *                   ▼                                  │
 *           ┌─ onDeviceCode(auth) ◄────────────────────┘  (fires once)
 *           │       │
 *           │       └─ resolves a deferred capturing the verification URLs
 *           │
 *           ▼
 *      REST handler returns OAuthFlowStart immediately
 *
 *                   meanwhile, the background facade.login() polls...
 *
 *           ┌─ resolves with KimiAuthLoginResult  →  flow status = 'authenticated'
 *           │                                        +  config.toml provisioned
 *           │                                        +  token saved to credentials
 *           │
 *           └─ rejects with one of:
 *                    DeviceCodeTimeoutError  →  'expired'
 *                    OAuthError("denied")    →  'denied'
 *                    OAuthError("aborted")   →  'cancelled'
 *                    other                   →  'denied' (generic failure)
 *
 *   GET /v1/oauth/login  →  getFlow()  →  snapshot of in-memory state
 *
 * **One in-flight per provider**: startLogin replaces an
 * existing pending flow by aborting its AbortController + flipping its
 * status to 'cancelled' BEFORE minting a new flow_id.
 *
 * **GC**: a 5-min timer fires after each terminal transition; the entry is
 * dropped on timer fire. Pending flows have no GC — they live until the
 * upstream 15-min device_code TTL expires + facade.login resolves with
 * `DeviceCodeTimeoutError`.
 */

import { createDecorator } from '../../di';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

export interface IOAuthService {
  readonly _serviceBrand: undefined;

  /**
   * Kick off a device-code flow for `providerName` (default
   * `'managed:kimi-code'`). Requests the device authorization synchronously
   * (1-2 round-trips to the OAuth host), starts background polling, and
   * returns the verification URLs + flow_id.
   *
   * Cancels any existing pending flow for the same provider before starting.
   */
  startLogin(providerName?: string): Promise<OAuthFlowStart>;

  /**
   * Snapshot the current flow state for `providerName`. Returns `undefined`
   * when no flow has been started (or was GC'd after 5 min in terminal state).
   */
  getFlow(providerName?: string): OAuthFlowSnapshot | undefined;

  /**
   * Cancel a pending flow. Idempotent: cancelling a terminal flow returns
   * `{cancelled: false, status: <current>}` instead of throwing.
   */
  cancelLogin(providerName?: string): Promise<OAuthLoginCancelResponse>;

  /**
   * Logout — delete the stored token + strip the managed provider's
   * `apply` config entries (provider + models). After this, `GET /v1/auth`
   * flips to `ready: false`.
   */
  logout(providerName?: string): Promise<OAuthLogoutResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IOAuthService = createDecorator<IOAuthService>('oauthService');
