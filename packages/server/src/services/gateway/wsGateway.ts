import { createDecorator, type TelemetryClient } from '@moonshot-ai/agent-core';

import type { HostCheckOptions } from '#/middleware/hostnames';
import type { IAuthTokenService } from '#/services/auth/authTokenService';
import type { AbortHandler, FsWatchHandler, TerminalHandler } from '#/ws/connection';

export const WS_PATH = '/api/v1/ws';

/**
 * `Sec-WebSocket-Protocol` subprotocol prefix used by browser clients to carry
 * the bearer token during the WS upgrade handshake (browsers cannot set
 * arbitrary headers on a WebSocket, so the token rides in a subprotocol). The
 * full offered subprotocol is `${WS_BEARER_PROTOCOL_PREFIX}<token>`.
 */
export const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export interface IWSGateway {
  readonly _serviceBrand: undefined;

  readonly size: number;

  setAbortHandler(handler: AbortHandler): void;

  setFsWatchHandler(handler: FsWatchHandler): void;

  setTerminalHandler(handler: TerminalHandler): void;

  /**
   * Install the `IAuthTokenService` used to validate bearer tokens on the WS
   * upgrade path. Wired by `start.ts` (M5.1) AFTER construction so the
   * ix-resolved, override-aware impl (not the constructor options) is what
   * enforces auth — letting test overrides via `serviceOverrides` take effect
   * for WS too. `WSGatewayOptions.authTokenService?` is retained only for the
   * M3/M4 unit tests that construct the gateway directly.
   */
  setAuthTokenService(service: IAuthTokenService): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSGateway = createDecorator<IWSGateway>('wsGateway');

/**
 * Extract the bearer token from a `Sec-WebSocket-Protocol` request header.
 *
 * The header is a comma-separated list of offered subprotocols (e.g.
 * `"kimi-code.bearer.abc, other"`). Returns the token portion of the first
 * entry whose subprotocol starts with {@link WS_BEARER_PROTOCOL_PREFIX}, or
 * `undefined` when the header is missing/empty, no entry matches, or the
 * matching entry carries an empty token.
 */
export function extractWsBearerToken(protocolHeader: string | undefined): string | undefined {
  if (protocolHeader === undefined || protocolHeader.length === 0) {
    return undefined;
  }
  for (const rawEntry of protocolHeader.split(',')) {
    const entry = rawEntry.trim();
    if (entry.startsWith(WS_BEARER_PROTOCOL_PREFIX)) {
      const token = entry.slice(WS_BEARER_PROTOCOL_PREFIX.length);
      if (token.length === 0) {
        return undefined;
      }
      return token;
    }
  }
  return undefined;
}

export interface WSGatewayOptions {
  pingIntervalMs?: number;

  pongTimeoutMs?: number;

  /**
   * Optional observer invoked after a client connects or disconnects, with the
   * live connection count. The daemon host uses it to detect the "last client
   * left" transition and start its idle-shutdown grace timer.
   */
  onConnectionCountChange?: (size: number) => void;

  /**
   * Optional telemetry client used to emit `ws_connected` / `ws_disconnected`
   * events. Hosts that already bootstrap telemetry (e.g. the CLI server
   * command) hand in the same client they pass to `coreProcessOptions` so all
   * web-path events share one sink + context.
   */
  telemetry?: TelemetryClient;

  /**
   * When set, the WS upgrade path requires a valid bearer token (via the
   * `Authorization` header or the `kimi-code.bearer.<token>` subprotocol).
   * When unset (e.g. tests / pre-M5.1 boots), upgrade auth is skipped.
   */
  authTokenService?: IAuthTokenService;

  /**
   * Optional Host-header allowlist enforced on the WS upgrade path (ROADMAP
   * M4.3). When set, upgrades whose `Host` is not allowed are rejected with
   * `403 Forbidden` before token validation. When unset (tests / pre-M5.1
   * boots), the WS Host check is skipped — HTTP-level Host enforcement in
   * `start.ts` still covers non-upgrade requests.
   */
  hostCheck?: HostCheckOptions;

  /**
   * Optional Origin allowlist enforced on the WS upgrade path (ROADMAP M4.3).
   * When set, a present browser `Origin` must be same-origin or listed here;
   * an absent `Origin` (Node `ws` clients) is allowed. When unset (tests /
   * pre-M5.1 boots), the WS Origin check is skipped.
   */
  allowedOrigins?: readonly string[];
}
