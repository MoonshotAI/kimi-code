/**
 * `app/llmProtocol/usage` — thin bridge re-exporting the kosong usage
 * contract so that v2 domain modules see the same TokenUsage shape everywhere.
 */
export type { TokenUsage } from '#/kosong/contract/usage';
export { inputTotal } from '#/kosong/contract/usage';
