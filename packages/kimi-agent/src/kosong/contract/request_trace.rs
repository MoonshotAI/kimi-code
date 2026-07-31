/// Live request provenance contract.
///
/// Corresponds to `kosong/contract/requestTrace.ts`.

/// Exposes the provider trace identifier of one logical LLM request.
#[derive(Debug, Clone)]
pub struct LLMRequestTrace {
    pub trace_id: Option<String>,
}