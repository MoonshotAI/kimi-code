/// Model auth helpers — effective model config resolution.
///
/// Corresponds to `kosong/model/modelAuth.ts`.
use crate::kosong::model::model::ModelRecord;

/// Effective model config after applying overrides.
pub fn effective_model_config(record: &ModelRecord, _provider_type: Option<&str>) -> ModelRecord {
    let mut effective = record.clone();
    if let Some(ref overrides) = record.overrides {
        if let Some(v) = &overrides.max_context_size {
            effective.max_context_size = Some(*v);
        }
        if let Some(v) = &overrides.max_input_size {
            effective.max_input_size = Some(*v);
        }
        if let Some(v) = &overrides.max_output_size {
            effective.max_output_size = Some(*v);
        }
        if let Some(v) = &overrides.capabilities {
            effective.capabilities = Some(v.clone());
        }
        if let Some(v) = &overrides.display_name {
            effective.display_name = Some(v.clone());
        }
        if let Some(v) = &overrides.reasoning_key {
            effective.reasoning_key = Some(v.clone());
        }
        if let Some(v) = &overrides.adaptive_thinking {
            effective.adaptive_thinking = Some(*v);
        }
        if let Some(v) = &overrides.support_efforts {
            effective.support_efforts = Some(v.clone());
        }
        if let Some(v) = &overrides.default_effort {
            effective.default_effort = Some(v.clone());
        }
    }
    effective
}