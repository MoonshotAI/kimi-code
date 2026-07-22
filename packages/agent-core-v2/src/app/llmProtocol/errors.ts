/**
 * `app/llmProtocol/errors` — thin bridge re-exporting the kosong errors
 * contract so that v2 domain modules see the same error types everywhere.
 */
export {
  ChatProviderError,
  type LLMRequestFinish,
} from '#/kosong/contract/errors';
export { APIStatusError } from '#/kosong/contract/errors';
