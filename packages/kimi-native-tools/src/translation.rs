/// i18n translation engine — resolves dot-separated keys against locale JSON
/// and interpolates `{{param}}` placeholders.
///
/// Designed to be the compiled core of the project's i18n system. Locale data
/// stays in TypeScript/JSON (easy to maintain); the engine that reads it is
/// compiled Rust — fixed, fast, and never lost.
///
/// # Design
///
/// - `resolve` walks a dot-separated key path into a parsed JSON value tree.
/// - `interpolate` replaces `{{param}}` tokens with supplied values.
/// - `translate` chains both: resolve → interpolate → fallback → return key.
///
/// The engine is stateless: all locale data is passed in at call time, so
/// the same engine serves every i18n module in the project.
///
/// # Caching
///
/// `CachedTranslator` wraps the engine with a parsed-JSON cache keyed by
/// locale JSON string. Use it when the same locale data is used repeatedly
/// (e.g. in a long-running server) to avoid re-parsing JSON on every call.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::RwLock;

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/// Walk a dot-separated `key` into `data` and return the leaf string value.
///
/// Returns `None` if the key path doesn't exist or the leaf is not a string.
pub fn resolve<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    let parts: Vec<&str> = key.split('.').collect();
    let mut current = data;
    for part in &parts {
        match current {
            Value::Object(map) => match map.get(*part) {
                Some(v) => current = v,
                None => return None,
            },
            _ => return None,
        }
    }
    current.as_str()
}

/// Replace `{{name}}` placeholders in `template` with values from `params`.
///
/// Unknown placeholders are left as-is (e.g. `{{missing}}` stays unchanged).
pub fn interpolate(template: &str, params: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;

    while let Some(start) = rest.find("{{") {
        // Push everything before `{{`
        result.push_str(&rest[..start]);
        rest = &rest[start + 2..];

        // Find the closing `}}`
        if let Some(end) = rest.find("}}") {
            let name = &rest[..end];
            rest = &rest[end + 2..];
            match params.get(name) {
                Some(value) => result.push_str(value),
                None => {
                    result.push_str("{{");
                    result.push_str(name);
                    result.push_str("}}");
                }
            }
        } else {
            // No closing `}}` — treat `{{` as literal text
            result.push_str("{{");
        }
    }

    result.push_str(rest);
    result
}

/// Resolve a translation key, then interpolate parameters.
///
/// Resolution order:
/// 1. Try `locale` (current language).
/// 2. Try `fallback` (usually English).
/// 3. Return the `key` itself as the last resort.
///
/// # Panics
///
/// Panics if `locale_json` or `fallback_json` is not valid JSON.
pub fn translate(
    locale_json: &str,
    fallback_json: &str,
    key: &str,
    params: Option<&HashMap<String, String>>,
) -> String {
    let locale_data: Value =
        serde_json::from_str(locale_json).expect("locale_json must be valid JSON");
    let fallback_data: Value =
        serde_json::from_str(fallback_json).expect("fallback_json must be valid JSON");

    let raw = resolve(&locale_data, key)
        .or_else(|| resolve(&fallback_data, key))
        .unwrap_or(key);

    match params {
        Some(p) => interpolate(raw, p),
        None => raw.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Batch translate
// ---------------------------------------------------------------------------

/// Result of a single translation in a batch.
#[derive(Debug)]
pub struct BatchResult {
    pub key: String,
    pub message: String,
}

/// Translate multiple keys in a single pass, parsing the JSON only once.
///
/// This is more efficient than calling `translate()` N times when you have
/// many keys to resolve against the same locale data.
pub fn translate_batch(
    locale_json: &str,
    fallback_json: &str,
    keys: &[String],
    params: Option<&HashMap<String, String>>,
) -> Vec<BatchResult> {
    let locale_data: Value =
        serde_json::from_str(locale_json).expect("locale_json must be valid JSON");
    let fallback_data: Value =
        serde_json::from_str(fallback_json).expect("fallback_json must be valid JSON");

    keys.iter()
        .map(|key| {
            let raw = resolve(&locale_data, key)
                .or_else(|| resolve(&fallback_data, key))
                .unwrap_or(key);
            let message = match params {
                Some(p) => interpolate(raw, p),
                None => raw.to_string(),
            };
            BatchResult {
                key: key.clone(),
                message,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Cached translator — reuses parsed JSON across calls
// ---------------------------------------------------------------------------

/// A thread-safe, locale-aware translator that caches parsed JSON internally.
///
/// Use this in long-running contexts (server, daemon, TUI session) where the
/// same locale JSON strings are used repeatedly. The cache is keyed by the
/// JSON string itself, so it automatically handles locale switching.
///
/// # Example
///
/// ```ignore
/// let t = CachedTranslator::new();
/// let msg = t.translate(locale_json, fallback_json, "common.ok", None);
/// ```
pub struct CachedTranslator {
    cache: RwLock<HashMap<String, Value>>,
}

impl CachedTranslator {
    /// Create a new cached translator with an empty JSON cache.
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Parse (or retrieve from cache) a JSON string into a Value.
    fn parse(&self, json: &str) -> Value {
        // Fast path: check cache (read lock)
        if let Some(cached) = self.cache.read().unwrap().get(json) {
            return cached.clone();
        }

        // Slow path: parse and cache (write lock)
        let value: Value =
            serde_json::from_str(json).expect("locale JSON must be valid");
        self.cache
            .write()
            .unwrap()
            .insert(json.to_string(), value.clone());
        value
    }

    /// Translate a single key, using cached JSON parsing.
    pub fn translate(
        &self,
        locale_json: &str,
        fallback_json: &str,
        key: &str,
        params: Option<&HashMap<String, String>>,
    ) -> String {
        let locale_data = self.parse(locale_json);
        let fallback_data = self.parse(fallback_json);

        let raw = resolve(&locale_data, key)
            .or_else(|| resolve(&fallback_data, key))
            .unwrap_or(key);

        match params {
            Some(p) => interpolate(raw, p),
            None => raw.to_string(),
        }
    }

    /// Translate multiple keys in a batch, parsing each locale JSON once.
    pub fn translate_batch(
        &self,
        locale_json: &str,
        fallback_json: &str,
        keys: &[String],
        params: Option<&HashMap<String, String>>,
    ) -> Vec<BatchResult> {
        let locale_data = self.parse(locale_json);
        let fallback_data = self.parse(fallback_json);

        keys.iter()
            .map(|key| {
                let raw = resolve(&locale_data, key)
                    .or_else(|| resolve(&fallback_data, key))
                    .unwrap_or(key);
                let message = match params {
                    Some(p) => interpolate(raw, p),
                    None => raw.to_string(),
                };
                BatchResult {
                    key: key.clone(),
                    message,
                }
            })
            .collect()
    }

    /// Clear the parsed-JSON cache (useful when locale data is reloaded).
    pub fn clear_cache(&self) {
        self.cache.write().unwrap().clear();
    }
}

impl Default for CachedTranslator {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn en() -> &'static str {
        r#"{
            "common": {
                "ok": "OK",
                "cancel": "Cancel",
                "greeting": "Hello, {{name}}!"
            },
            "errors": {
                "notFound": "{{item}} not found",
                "multi": "Found {{count}} {{item}}s in {{location}}"
            },
            "deep": {
                "nested": {
                    "key": "Deep value"
                }
            }
        }"#
    }

    fn zh() -> &'static str {
        r#"{
            "common": {
                "ok": "确定",
                "cancel": "取消",
                "greeting": "你好，{{name}}！"
            },
            "errors": {
                "notFound": "未找到{{item}}"
            }
        }"#
    }

    // ── resolve ──────────────────────────────────────────────────────────

    #[test]
    fn test_resolve_simple_key() {
        let data: Value = serde_json::from_str(en()).unwrap();
        assert_eq!(resolve(&data, "common.ok"), Some("OK"));
        assert_eq!(resolve(&data, "common.cancel"), Some("Cancel"));
    }

    #[test]
    fn test_resolve_nonexistent_key() {
        let data: Value = serde_json::from_str(en()).unwrap();
        assert_eq!(resolve(&data, "common.nonexistent"), None);
        assert_eq!(resolve(&data, "foo.bar.baz"), None);
    }

    #[test]
    fn test_resolve_deeply_nested() {
        let data: Value = serde_json::from_str(en()).unwrap();
        assert_eq!(resolve(&data, "deep.nested.key"), Some("Deep value"));
    }

    #[test]
    fn test_resolve_empty_key() {
        let data: Value = serde_json::from_str(en()).unwrap();
        assert_eq!(resolve(&data, ""), None);
    }

    #[test]
    fn test_resolve_non_string_leaf() {
        let data: Value = serde_json::from_str(r#"{"obj": {"nested": {}}}"#).unwrap();
        assert_eq!(resolve(&data, "obj.nested"), None);
    }

    #[test]
    fn test_resolve_null_value() {
        let data: Value = serde_json::from_str(r#"{"key": null}"#).unwrap();
        assert_eq!(resolve(&data, "key"), None);
    }

    #[test]
    fn test_resolve_number_value() {
        let data: Value = serde_json::from_str(r#"{"key": 42}"#).unwrap();
        assert_eq!(resolve(&data, "key"), None);
    }

    // ── interpolate ──────────────────────────────────────────────────────

    #[test]
    fn test_interpolate_simple() {
        let mut params = HashMap::new();
        params.insert("name".to_string(), "World".to_string());
        assert_eq!(interpolate("Hello, {{name}}!", &params), "Hello, World!");
    }

    #[test]
    fn test_interpolate_multiple() {
        let mut params = HashMap::new();
        params.insert("item".to_string(), "File".to_string());
        params.insert("count".to_string(), "3".to_string());
        assert_eq!(
            interpolate("Found {{count}} {{item}}s", &params),
            "Found 3 Files"
        );
    }

    #[test]
    fn test_interpolate_many_params() {
        let mut params = HashMap::new();
        params.insert("count".to_string(), "5".to_string());
        params.insert("item".to_string(), "record".to_string());
        params.insert("location".to_string(), "database".to_string());
        assert_eq!(
            interpolate("Found {{count}} {{item}}s in {{location}}", &params),
            "Found 5 records in database"
        );
    }

    #[test]
    fn test_interpolate_missing_param() {
        let params = HashMap::new();
        assert_eq!(
            interpolate("Hello, {{name}}!", &params),
            "Hello, {{name}}!"
        );
    }

    #[test]
    fn test_interpolate_no_placeholders() {
        let params = HashMap::new();
        assert_eq!(interpolate("Plain text", &params), "Plain text");
    }

    #[test]
    fn test_interpolate_empty_string() {
        let params = HashMap::new();
        assert_eq!(interpolate("", &params), "");
    }

    #[test]
    fn test_interpolate_consecutive_placeholders() {
        let mut params = HashMap::new();
        params.insert("a".to_string(), "x".to_string());
        params.insert("b".to_string(), "y".to_string());
        assert_eq!(interpolate("{{a}}{{b}}", &params), "xy");
    }

    #[test]
    fn test_interpolate_unclosed_placeholder() {
        let mut params = HashMap::new();
        params.insert("name".to_string(), "x".to_string());
        // `{{name` without closing `}}` should be treated as literal
        assert_eq!(interpolate("Hello {{name", &params), "Hello {{name");
    }

    #[test]
    fn test_interpolate_empty_placeholder() {
        let params = HashMap::new();
        assert_eq!(interpolate("{{}}", &params), "{{}}");
    }

    // ── translate ────────────────────────────────────────────────────────

    #[test]
    fn test_translate_zh() {
        let mut params = HashMap::new();
        params.insert("name".to_string(), "世界".to_string());
        let result = translate(zh(), en(), "common.greeting", Some(&params));
        assert_eq!(result, "你好，世界！");
    }

    #[test]
    fn test_translate_zh_missing_fallsback_to_en() {
        let data_zh = r#"{"common": {"ok": "确定"}}"#;
        let data_en = r#"{"common": {"foo": "bar"}}"#;
        let result = translate(data_zh, data_en, "common.foo", None);
        assert_eq!(result, "bar");
    }

    #[test]
    fn test_translate_missing_key_returns_key() {
        let result = translate(en(), en(), "nonexistent.key", None);
        assert_eq!(result, "nonexistent.key");
    }

    #[test]
    fn test_translate_no_params() {
        let result = translate(en(), en(), "common.ok", None);
        assert_eq!(result, "OK");
    }

    #[test]
    fn test_translate_empty_params() {
        let params = HashMap::new();
        let result = translate(en(), en(), "common.ok", Some(&params));
        assert_eq!(result, "OK");
    }

    #[test]
    fn test_translate_zh_ok() {
        let result = translate(zh(), en(), "common.ok", None);
        assert_eq!(result, "确定");
    }

    // ── translate_batch ──────────────────────────────────────────────────

    #[test]
    fn test_translate_batch_multiple_keys() {
        let keys = vec![
            "common.ok".to_string(),
            "common.cancel".to_string(),
            "nonexistent.key".to_string(),
        ];
        let results = translate_batch(en(), en(), &keys, None);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].message, "OK");
        assert_eq!(results[1].message, "Cancel");
        assert_eq!(results[2].message, "nonexistent.key");
    }

    #[test]
    fn test_translate_batch_with_params() {
        let keys = vec!["common.greeting".to_string(), "errors.notFound".to_string()];
        let mut params = HashMap::new();
        params.insert("name".to_string(), "Alice".to_string());
        params.insert("item".to_string(), "File".to_string());
        let results = translate_batch(zh(), en(), &keys, Some(&params));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].message, "你好，Alice！");
        assert_eq!(results[1].message, "未找到File");
    }

    #[test]
    fn test_translate_batch_empty() {
        let keys: Vec<String> = vec![];
        let results = translate_batch(en(), en(), &keys, None);
        assert!(results.is_empty());
    }

    // ── CachedTranslator ─────────────────────────────────────────────────

    #[test]
    fn test_cached_translator_simple() {
        let t = CachedTranslator::new();
        let msg = t.translate(en(), en(), "common.ok", None);
        assert_eq!(msg, "OK");
    }

    #[test]
    fn test_cached_translator_with_params() {
        let t = CachedTranslator::new();
        let mut params = HashMap::new();
        params.insert("name".to_string(), "Rust".to_string());
        let msg = t.translate(en(), en(), "common.greeting", Some(&params));
        assert_eq!(msg, "Hello, Rust!");
    }

    #[test]
    fn test_cached_translator_fallback() {
        let t = CachedTranslator::new();
        let data_zh = r#"{"common": {"ok": "确定"}}"#;
        let data_en = r#"{"common": {"foo": "bar"}}"#;
        let msg = t.translate(data_zh, data_en, "common.foo", None);
        assert_eq!(msg, "bar");
    }

    #[test]
    fn test_cached_translator_batch() {
        let t = CachedTranslator::new();
        let keys = vec![
            "common.ok".to_string(),
            "common.cancel".to_string(),
        ];
        let results = t.translate_batch(en(), en(), &keys, None);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].message, "OK");
        assert_eq!(results[1].message, "Cancel");
    }

    #[test]
    fn test_cached_translator_clear_cache() {
        let t = CachedTranslator::new();
        let msg1 = t.translate(en(), en(), "common.ok", None);
        assert_eq!(msg1, "OK");
        t.clear_cache();
        let msg2 = t.translate(en(), en(), "common.ok", None);
        assert_eq!(msg2, "OK");
    }

    #[test]
    fn test_cached_translator_locale_switch() {
        let t = CachedTranslator::new();
        // Translate with en
        let en_msg = t.translate(en(), en(), "common.ok", None);
        assert_eq!(en_msg, "OK");
        // Translate with zh (same cache, different key because JSON string differs)
        let zh_msg = t.translate(zh(), en(), "common.ok", None);
        assert_eq!(zh_msg, "确定");
        // Both should be cached independently
        assert_eq!(t.cache.read().unwrap().len(), 2);
    }

    // ── Edge cases ───────────────────────────────────────────────────────

    #[test]
    fn test_translate_key_with_dots_is_path_separator() {
        let data = r#"{"a": {"b": {"c": "value"}}}"#;
        // The key "a.b.c" is split into ["a", "b", "c"] path segments
        let result = translate(data, data, "a.b.c", None);
        assert_eq!(result, "value");
    }

    #[test]
    fn test_translate_unicode() {
        let data = r#"{"greeting": "こんにちは、{{name}}さん"}"#;
        let mut params = HashMap::new();
        params.insert("name".to_string(), "世界".to_string());
        let result = translate(data, data, "greeting", Some(&params));
        assert_eq!(result, "こんにちは、世界さん");
    }

    #[test]
    fn test_interpolate_special_chars_in_params() {
        let mut params = HashMap::new();
        params.insert("text".to_string(), "a<b>c&d\"e'".to_string());
        assert_eq!(
            interpolate("{{text}}", &params),
            "a<b>c&d\"e'"
        );
    }
}