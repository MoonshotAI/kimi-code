//! Tool JSON-Schema normalization for strict provider validators.
//!
//! Ported from kosong's `providers/kimi-schema.ts` (G-5: the Rust engine's
//! native LLM transport must carry the same compatibility fixes the TS
//! abstraction used to provide). Moonshot's tool validator rejects some
//! otherwise-valid JSON Schema shapes — most importantly local `$ref`
//! pointers and nested property schemas that omit `type` (enum-only MCP
//! properties are the common trigger). The normalizer:
//!
//! 1. dereferences local JSON-pointer `$ref`s by inlining the definitions
//!    (circular refs stay as `$ref`; sibling keywords merge per JSON Schema
//!    2020-12);
//! 2. fills missing `type` fields on nested property schemas by inferring
//!    from `enum`/`const` values or structural keywords, falling back to
//!    `string`; and repairs an explicit `type` that contradicts the
//!    `enum`/`const` values (a known MCP-server generator bug).
//!
//! The root schema object is treated as a container and is not itself
//! normalized. Semantics are preserved for validators that accept the
//! original shapes.

use serde_json::{Map, Value};

/// Normalize a tool schema for strict provider validators: dereference local
/// refs, then complete nested property types.
pub fn normalize_tool_schema(schema: &Value) -> Value {
    let dereferenced = deref_json_schema(schema);
    complete_schema_types(&dereferenced)
}

/// Dereference all local JSON-pointer `$ref`s by inlining definitions from
/// `$defs` / `definitions`. Circular references are detected and left as
/// `$ref`; the referenced definition bucket is preserved in that case so the
/// remaining pointers stay resolvable. Unknown (non-local) refs pass through.
pub fn deref_json_schema(schema: &Value) -> Value {
    let mut visited = std::collections::HashSet::new();
    let result = resolve_node(schema, schema, &mut visited);
    // Only delete definition buckets if no refs into them remain.
    let mut out = result;
    for bucket in ["$defs", "definitions"] {
        if !has_unresolved_definition_ref(&out, bucket)
            && let Value::Object(map) = &mut out
        {
            map.remove(bucket);
        }
    }
    out
}

/// Recursively resolve local `$ref` pointers against `root`.
fn resolve_node(node: &Value, root: &Value, visited: &mut std::collections::HashSet<String>) -> Value {
    match node {
        Value::Array(items) => Value::Array(items.iter().map(|i| resolve_node(i, root, visited)).collect()),
        Value::Object(obj) => {
            if let Some(Value::String(ref_text)) = obj.get("$ref") {
                if is_local_json_pointer_ref(ref_text) {
                    if visited.contains(ref_text) {
                        return node.clone(); // circular — keep the $ref
                    }
                    if let Some(resolved_value) = resolve_local_json_pointer(root, ref_text) {
                        visited.insert(ref_text.clone());
                        let resolved = resolve_node(&resolved_value, root, visited);
                        visited.remove(ref_text);
                        // Merge sibling keywords (JSON Schema 2020-12): local
                        // sibling keys take precedence over the definition.
                        if let Value::Object(resolved_map) = resolved {
                            let mut merged = resolved_map;
                            for (key, value) in obj {
                                if key != "$ref" {
                                    merged.insert(key.clone(), resolve_node(value, root, visited));
                                }
                            }
                            return Value::Object(merged);
                        }
                        return resolved;
                    }
                }
                return node.clone(); // unknown ref — pass through
            }
            let mut resolved = Map::new();
            for (key, value) in obj {
                resolved.insert(key.clone(), resolve_node(value, root, visited));
            }
            Value::Object(resolved)
        }
        _ => node.clone(),
    }
}

fn is_local_json_pointer_ref(reference: &str) -> bool {
    reference == "#" || reference.starts_with("#/")
}

/// Resolve a local JSON pointer (`#` or `#/a/b`) against the root; `None`
/// when any path segment is missing.
fn resolve_local_json_pointer(root: &Value, reference: &str) -> Option<Value> {
    if reference == "#" {
        return Some(root.clone());
    }
    let mut current: &Value = root;
    for raw_part in reference[2..].split('/') {
        let part = raw_part.replace("~1", "/").replace("~0", "~");
        match current {
            Value::Object(map) => current = map.get(&part)?,
            Value::Array(items) => {
                if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let index: usize = part.parse().ok()?;
                current = items.get(index)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

/// Whether any `$ref` into the given definition bucket survives in `node`.
fn has_unresolved_definition_ref(node: &Value, bucket_key: &str) -> bool {
    match node {
        Value::Array(items) => items.iter().any(|i| has_unresolved_definition_ref(i, bucket_key)),
        Value::Object(obj) => {
            if let Some(Value::String(reference)) = obj.get("$ref")
                && reference.starts_with("#/")
                && reference[2..].starts_with(bucket_key)
                && reference[2 + bucket_key.len()..].starts_with('/')
            {
                return true;
            }
            for (key, value) in obj {
                if key == bucket_key {
                    continue;
                }
                if has_unresolved_definition_ref(value, bucket_key) {
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

// ── Type completion ────────────────────────────────────────────────────────

/// Child-schema positions the normalizer walks, plus the structural keyword
/// that implies a parent's type. Mirrors kosong's `CHILD_SCHEMA_SLOTS`.
const CHILD_SCHEMA_SLOTS: &[(&str, SlotKind)] = &[
    ("$defs", SlotKind::Map),
    ("definitions", SlotKind::Map),
    ("dependencies", SlotKind::Map),
    ("dependentSchemas", SlotKind::Map),
    ("patternProperties", SlotKind::Map),
    ("properties", SlotKind::Map),
    ("additionalItems", SlotKind::Single),
    ("additionalProperties", SlotKind::Single),
    ("contains", SlotKind::Single),
    ("contentSchema", SlotKind::Single),
    ("else", SlotKind::Single),
    ("if", SlotKind::Single),
    ("not", SlotKind::Single),
    ("propertyNames", SlotKind::Single),
    ("then", SlotKind::Single),
    ("unevaluatedItems", SlotKind::Single),
    ("unevaluatedProperties", SlotKind::Single),
    ("allOf", SlotKind::Array),
    ("anyOf", SlotKind::Array),
    ("oneOf", SlotKind::Array),
    ("prefixItems", SlotKind::Array),
    ("items", SlotKind::SchemaOrArray),
];

#[derive(Clone, Copy)]
enum SlotKind {
    Single,
    Array,
    Map,
    SchemaOrArray,
}

const TYPE_COMPLETION_SKIP_KEYS: &[&str] = &[
    "$ref", "allOf", "anyOf", "else", "if", "not", "oneOf", "then",
];

const OBJECT_STRUCTURE_KEYS: &[&str] = &[
    "additionalProperties", "dependencies", "dependentSchemas", "patternProperties",
    "properties", "propertyNames", "unevaluatedProperties", "dependentRequired",
    "maxProperties", "minProperties", "required",
];

const ARRAY_STRUCTURE_KEYS: &[&str] = &[
    "additionalItems", "contains", "prefixItems", "items", "unevaluatedItems",
    "maxContains", "maxItems", "minContains", "minItems", "uniqueItems",
];

const STRING_STRUCTURE_KEYS: &[&str] = &[
    "contentEncoding", "contentMediaType", "contentSchema", "format", "maxLength",
    "minLength", "pattern",
];

const NUMERIC_STRUCTURE_KEYS: &[&str] = &[
    "exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum", "multipleOf",
];

/// Fill missing `type` fields on nested property schemas (the root is a
/// container and is not normalized). Repairs explicit types that contradict
/// `enum`/`const` values (a known MCP-server generator bug Moonshot rejects).
pub fn complete_schema_types(schema: &Value) -> Value {
    let mut out = schema.clone();
    recurse_schema(&mut out);
    out
}

fn recurse_schema(node: &mut Value) {
    let Value::Object(_) = node else { return };
    visit_child_schemas(node, normalize_property);
}

fn visit_child_schemas(node: &mut Value, visit: fn(&mut Value)) {
    let Value::Object(map) = node else { return };
    for (key, kind) in CHILD_SCHEMA_SLOTS {
        let Some(value) = map.get_mut(*key) else { continue };
        match kind {
            SlotKind::Single => {
                if value.is_object() {
                    visit(value);
                }
            }
            SlotKind::Array => {
                if let Value::Array(items) = value {
                    for item in items {
                        visit(item);
                    }
                }
            }
            SlotKind::Map => {
                if let Value::Object(entries) = value {
                    for item in entries.values_mut() {
                        visit(item);
                    }
                }
            }
            SlotKind::SchemaOrArray => {
                if value.is_object() {
                    visit(value);
                } else if let Value::Array(items) = value {
                    for item in items {
                        visit(item);
                    }
                }
            }
        }
    }
}

fn normalize_property(node: &mut Value) {
    let Value::Object(map) = node else { return };
    let has_type = map.contains_key("type");
    let has_skip = TYPE_COMPLETION_SKIP_KEYS.iter().any(|k| map.contains_key(*k));
    if !has_type && !has_skip {
        if let Some(Value::Array(values)) = map.get("enum")
            && !values.is_empty()
            && let Some(inferred) = infer_type_from_values(values)
        {
            map.insert("type".to_string(), Value::String(inferred.to_string()));
        } else if let Some(value) = map.get("const")
            && let Some(inferred) = infer_type_from_values(std::slice::from_ref(value))
        {
            map.insert("type".to_string(), Value::String(inferred.to_string()));
        } else {
            let inferred = infer_type_from_structure(map);
            map.insert("type".to_string(), Value::String(inferred.to_string()));
        }
    } else if !has_skip {
        // Repair an explicit type that contradicts enum/const values.
        if let Some(Value::Array(values)) = map.get("enum")
            && !values.is_empty()
            && let Some(inferred) = infer_type_from_values(values)
        {
            repair_type(map, inferred);
        } else if let Some(value) = map.get("const")
            && let Some(inferred) = infer_type_from_values(std::slice::from_ref(value))
        {
            repair_type(map, inferred);
        }
    }
    recurse_schema(node);
}

fn repair_type(map: &mut Map<String, Value>, inferred: &str) {
    let mismatched = map
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| t != inferred);
    if mismatched {
        map.insert("type".to_string(), Value::String(inferred.to_string()));
        remove_irrelevant_structure_keys(map, inferred);
    }
}

fn remove_irrelevant_structure_keys(map: &mut Map<String, Value>, new_type: &str) {
    if new_type != "object" {
        for key in OBJECT_STRUCTURE_KEYS {
            map.remove(*key);
        }
    }
    if new_type != "array" {
        for key in ARRAY_STRUCTURE_KEYS {
            map.remove(*key);
        }
    }
}

fn infer_type_from_structure(map: &Map<String, Value>) -> &'static str {
    if OBJECT_STRUCTURE_KEYS.iter().any(|k| map.contains_key(*k)) {
        return "object";
    }
    if ARRAY_STRUCTURE_KEYS.iter().any(|k| map.contains_key(*k)) {
        return "array";
    }
    if STRING_STRUCTURE_KEYS.iter().any(|k| map.contains_key(*k)) {
        return "string";
    }
    if NUMERIC_STRUCTURE_KEYS.iter().any(|k| map.contains_key(*k)) {
        return "number";
    }
    "string"
}

fn infer_type_from_values(values: &[Value]) -> Option<&'static str> {
    let mut inferred: Option<&'static str> = None;
    for value in values {
        let candidate = match value {
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Null => continue,
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        };
        match inferred {
            None => inferred = Some(candidate),
            Some(prev) if prev != candidate => return None, // mixed — uninferable
            _ => {}
        }
    }
    inferred
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derefs_local_refs_and_drops_def_buckets() {
        let schema = json!({
            "type": "object",
            "properties": {
                "a": { "$ref": "#/$defs/entry" }
            },
            "$defs": {
                "entry": { "type": "string", "description": "an entry" }
            }
        });
        let normalized = deref_json_schema(&schema);
        assert_eq!(
            normalized["properties"]["a"],
            json!({ "type": "string", "description": "an entry" }),
            "ref inlined: {normalized}"
        );
        assert!(normalized.get("$defs").is_none(), "def bucket dropped: {normalized}");
    }

    #[test]
    fn circular_refs_stay_resolved() {
        let schema = json!({
            "type": "object",
            "properties": {
                "child": { "$ref": "#/$defs/node" }
            },
            "$defs": {
                "node": {
                    "type": "object",
                    "properties": {
                        "next": { "$ref": "#/$defs/node" }
                    }
                }
            }
        });
        let normalized = deref_json_schema(&schema);
        // The inner cycle is preserved as a $ref and its bucket survives.
        assert_eq!(normalized["properties"]["child"]["properties"]["next"]["$ref"], "#/$defs/node");
        assert!(normalized.get("$defs").is_some(), "bucket kept for the cycle: {normalized}");
    }

    #[test]
    fn sibling_keywords_merge_with_resolved_ref() {
        let schema = json!({
            "type": "object",
            "properties": {
                "a": { "$ref": "#/definitions/base", "description": "local" }
            },
            "definitions": {
                "base": { "type": "string" }
            }
        });
        let normalized = deref_json_schema(&schema);
        assert_eq!(
            normalized["properties"]["a"],
            json!({ "type": "string", "description": "local" }),
            "sibling merged: {normalized}"
        );
    }

    #[test]
    fn unknown_refs_pass_through() {
        let schema = json!({
            "type": "object",
            "properties": { "a": { "$ref": "https://example.test/schema#/x" } }
        });
        let normalized = deref_json_schema(&schema);
        assert_eq!(normalized["properties"]["a"]["$ref"], "https://example.test/schema#/x");
    }

    #[test]
    fn fills_missing_types_from_structure() {
        let schema = json!({
            "type": "object",
            "properties": {
                "obj": { "properties": { "x": {} } },
                "arr": { "items": { "type": "string" } },
                "str": { "pattern": "^a" },
                "num": { "minimum": 0 },
                "plain": { "enum": ["a", "b"] },
                "constBool": { "const": true }
            }
        });
        let normalized = complete_schema_types(&schema);
        let props = &normalized["properties"];
        assert_eq!(props["obj"]["type"], "object", "{props}");
        assert_eq!(props["arr"]["type"], "array", "{props}");
        assert_eq!(props["str"]["type"], "string", "{props}");
        assert_eq!(props["num"]["type"], "number", "{props}");
        assert_eq!(props["plain"]["type"], "string", "{props}");
        assert_eq!(props["constBool"]["type"], "boolean", "{props}");
        // Root itself is a container and is not normalized.
        assert_eq!(normalized["type"], "object");
    }

    #[test]
    fn repairs_contradictory_explicit_type() {
        // Xcode MCP (xcrun mcpbridge) bug: type object + string enum values.
        let schema = json!({
            "type": "object",
            "properties": {
                "mode": { "type": "object", "enum": ["auto", "manual"] }
            }
        });
        let normalized = complete_schema_types(&schema);
        assert_eq!(normalized["properties"]["mode"]["type"], "string", "{normalized}");
    }

    #[test]
    fn normalize_is_idempotent() {
        let schema = json!({
            "type": "object",
            "properties": {
                "a": { "$ref": "#/$defs/entry" }
            },
            "$defs": {
                "entry": { "type": "string" }
            }
        });
        let once = normalize_tool_schema(&schema);
        let twice = normalize_tool_schema(&once);
        assert_eq!(once, twice, "idempotent");
    }
}
