/**
 * `kosong/contract` domain (L0) — live request provenance contract.
 *
 * Exposes the provider trace identifier of one logical LLM request while its
 * result is still pending. Pure contract (types only); no scoped service.
 */

export interface LLMRequestTrace {
  readonly traceId: string | undefined;
}
