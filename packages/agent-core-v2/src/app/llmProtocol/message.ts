/**
 * `app/llmProtocol/message` — thin bridge re-exporting the kosong message
 * contract so that v2 domain modules see the same Message shape everywhere.
 */
export type { Message } from '#/kosong/contract/message';
export { createUserMessage, extractText } from '#/kosong/contract/message';
