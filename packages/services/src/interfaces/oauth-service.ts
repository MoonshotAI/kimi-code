/**
 * `IOAuthService` — daemon-facing device-code login orchestration (P2.7).
 *
 * Bridges the OAuth toolkit's `login({onDeviceCode})` callback shape to a
 * REST resource: the frontend POSTs to start, gets a `verification_uri`
 * synchronously, then polls a GET endpoint for status transitions while the
 * daemon polls the OAuth host in the background.
 *
 * **One in-flight flow per provider** (PLAN D6.4). A second start cancels
 * the existing pending flow first (transitions it to `'cancelled'`) then
 * mints a fresh `flow_id`. Completed flows live in-memory for 5 min so the
 * frontend's last poll lands on the terminal status; after that, they GC
 * and `getFlow()` returns `undefined`.
 *
 * **No client coupling** (PLAN D6.5). Daemon does NOT detect frontend exit
 * / WS disconnect. Cleanup paths:
 *   1. 15-min upstream timeout (DeviceCodeTimeoutError → 'expired')
 *   2. Explicit `cancelLogin()` (→ 'cancelled')
 *   3. Same-provider new flow superseding (→ 'cancelled')
 *
 * **Token + config** land via the toolkit's provisioning path: on success,
 * the `managed:kimi-code` provider + models entry are written to
 * `config.toml`, and the cached token is saved to credentials. Frontend
 * follow-up: hit `GET /v1/auth` to confirm `ready: true`.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
} from '@moonshot-ai/protocol';

export interface IOAuthService {
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
export const IOAuthService = createDecorator<IOAuthService>('IOAuthService');
