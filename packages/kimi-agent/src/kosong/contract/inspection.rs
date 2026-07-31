/// Resolution-provenance annotations.
///
/// Corresponds to `kosong/contract/inspection.ts`.
use serde::{Deserialize, Serialize};

/// The origin of a settled field value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectionSourceKind {
    Config,
    Override,
    Builtin,
    Env,
    Synthesized,
    None,
}

/// Provenance annotation for a single resolved field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InspectionSource {
    pub kind: InspectionSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl InspectionSource {
    pub fn new(kind: InspectionSourceKind) -> Self {
        Self { kind, detail: None }
    }

    pub fn with_detail(kind: InspectionSourceKind, detail: &str) -> Self {
        Self {
            kind,
            detail: Some(detail.to_string()),
        }
    }
}

/// Collector for resolution trace data.
pub struct ResolutionTrace {
    records: Vec<(String, InspectionSource)>,
    captures: Vec<(String, serde_json::Value)>,
}

impl ResolutionTrace {
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
            captures: Vec::new(),
        }
    }

    pub fn record(&mut self, path: &str, source: InspectionSource) {
        self.records.push((path.to_string(), source));
    }

    pub fn capture(&mut self, key: &str, value: serde_json::Value) {
        self.captures.push((key.to_string(), value));
    }
}