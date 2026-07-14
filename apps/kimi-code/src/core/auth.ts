/**
 * Auth surface of the v2 facade (`#/core`).
 *
 * TODO(migrate): KimiAuthFacade lives in node-sdk but is RPC-free (config file
 * + oauth toolkit only). Re-exported for now; move the implementation into
 * this module (depending on @moonshot-ai/kimi-code-oauth directly) in a
 * follow-up so the TUI path fully drops its node-sdk dependency.
 */

import type { OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';

export { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';
export type {
  KimiAuthCompleteFeedbackUploadInput,
  KimiAuthCompleteFeedbackUploadPart,
  KimiAuthCreateFeedbackUploadUrlInput,
  KimiAuthCreateFeedbackUploadUrlOk,
  KimiAuthCreateFeedbackUploadUrlResult,
  KimiAuthFeedbackUploadPart,
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
} from '@moonshot-ai/kimi-code-sdk';
export {
  assertKimiHostIdentity,
  type KimiHostIdentity,
  type OAuthRefreshOutcome,
} from '@moonshot-ai/kimi-code-oauth';

/**
 * Callback invoked after a managed OAuth token refresh. The v1 SDK typed this
 * inline on `KimiHarnessOptions.onOAuthRefresh`; named here for the facade.
 */
export type OAuthRefreshHandler = (outcome: OAuthRefreshOutcome) => void;
