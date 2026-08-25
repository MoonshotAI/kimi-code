/**
 * Browser-safe entry for the device-code flow (`@moonshot-ai/kimi-code-oauth/device`).
 *
 * The package root re-exports `OAuthManager`, token storage, and the identity
 * helpers, which pull in `node:fs` / `node:os` / `proper-lockfile` — fine for
 * the CLI and desktop hosts, but unloadable in a browser bundle. This entry
 * re-exports only the pure-`fetch` surface (every module in its import
 * closure is Node-free): the three HTTP wrappers, the shared flow config,
 * and the matching types/errors. Keep it that way — anything that needs a
 * Node builtin belongs behind the root entry, not here.
 *
 * Browser callers drive the flow themselves (request → show the verification
 * URI → poll → store the token); there is no manager here on purpose.
 */

export { KIMI_CODE_FLOW_CONFIG } from './constants';
export {
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';
export type { DevicePollResult, RefreshOptions } from './oauth';
export { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from './oauth';
export type {
  DeviceAuthorization,
  DeviceHeaders,
  OAuthFlowConfig,
  OAuthRequestHeaders,
  TokenInfo,
} from './types';
