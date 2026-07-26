/// Byte-bounded LRU cache — pure JSON state manipulation for v2 migration.
///
/// A cache whose capacity is measured in bytes rather than entries.
/// Operates on JSON state directly for napi compatibility.
///
/// Corresponds to `packages/agent-core-v2/src/agent/blob/byteLruCache.ts`.
use napi_derive::napi;

/// Create a new byte-bounded LRU cache state.
/// Returns JSON: { maxBytes: number, currentBytes: number, entries: { key: string, value: number[] }[] }
#[napi]
pub fn native_byte_lru_cache_new(max_bytes: f64) -> String {
    let state = serde_json::json!({
        "maxBytes": max_bytes as u64,
        "currentBytes": 0u64,
        "entries": [],
    });
    serde_json::to_string(&state).unwrap_or_default()
}

/// Get a value from the LRU cache via pure JSON state manipulation.
/// cache_json: { maxBytes: number, currentBytes: number, entries: { key: string, value: number[] }[] }
/// key: the key to look up
/// Returns JSON: { cache: updated state, found: bool, value?: number[] }
#[napi]
pub fn native_byte_lru_cache_get(cache_json: String, key: String) -> String {
    let mut cache: serde_json::Value =
        serde_json::from_str(&cache_json).unwrap_or(serde_json::Value::Null);

    let entries = cache["entries"].as_array_mut();
    let found_entry = entries.and_then(|arr| {
        let pos = arr.iter().position(|e| e["key"].as_str() == Some(&key));
        pos.map(|i| arr.remove(i))
    });

    if let Some(entry) = found_entry {
        // Move to back (most recently used)
        if let Some(arr) = cache["entries"].as_array_mut() {
            arr.push(entry);
        }
        let value = cache["entries"].as_array()
            .and_then(|arr| arr.last())
            .and_then(|e| e["value"].as_array())
            .map(|v| {
                let bytes: Vec<f64> = v.iter().filter_map(|b| b.as_f64()).collect();
                bytes
            });

        let result = serde_json::json!({
            "cache": cache,
            "found": true,
            "value": value,
        });
        return serde_json::to_string(&result).unwrap_or_default();
    }

    let result = serde_json::json!({
        "cache": cache,
        "found": false,
        "value": null,
    });
    serde_json::to_string(&result).unwrap_or_default()
}

/// Set a value in the LRU cache via pure JSON state manipulation.
/// cache_json: { maxBytes: number, currentBytes: number, entries: { key: string, value: number[] }[] }
/// key: the key
/// value_json: JSON array of bytes (as numbers)
/// Returns JSON: updated cache state
#[napi]
pub fn native_byte_lru_cache_set(cache_json: String, key: String, value_json: String) -> String {
    let mut cache: serde_json::Value =
        serde_json::from_str(&cache_json).unwrap_or(serde_json::Value::Null);

    let max_bytes = cache["maxBytes"].as_f64().unwrap_or(0.0) as u64;
    let mut current_bytes = cache["currentBytes"].as_f64().unwrap_or(0.0) as u64;
    let entries = cache["entries"].as_array_mut();

    let value_arr: Vec<f64> = serde_json::from_str(&value_json).unwrap_or_default();
    let size = value_arr.len() as u64;

    if size > max_bytes {
        // Value too large to cache — remove existing if present
        if let Some(arr) = entries {
            arr.retain(|e| e["key"].as_str() != Some(&key));
        }
        cache["currentBytes"] = serde_json::json!(current_bytes);
        return serde_json::to_string(&cache).unwrap_or_default();
    }

    if let Some(arr) = entries {
        // Remove existing entry if present
        let existing_pos = arr.iter().position(|e| e["key"].as_str() == Some(&key));
        if let Some(pos) = existing_pos {
            if let Some(existing) = arr.get(pos) {
                if let Some(v) = existing["value"].as_array() {
                    current_bytes -= v.len() as u64;
                }
            }
            arr.remove(pos);
        }

        // Evict until space is available
        while !arr.is_empty() && current_bytes + size > max_bytes {
            if let Some(oldest) = arr.get(0) {
                if let Some(v) = oldest["value"].as_array() {
                    current_bytes -= v.len() as u64;
                }
            }
            arr.remove(0);
        }

        // Add new entry at back (most recently used)
        let new_entry = serde_json::json!({
            "key": key,
            "value": value_arr,
        });
        arr.push(new_entry);
    }

    current_bytes += size;
    cache["currentBytes"] = serde_json::json!(current_bytes);

    serde_json::to_string(&cache).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lru_cache_new() {
        let result = native_byte_lru_cache_new(1000.0);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["maxBytes"], 1000);
        assert_eq!(parsed["currentBytes"], 0);
    }

    #[test]
    fn test_lru_cache_set_and_get() {
        let cache = native_byte_lru_cache_new(1000.0);
        let value = serde_json::json!([104, 101, 108, 108, 111]); // "hello"
        let cache = native_byte_lru_cache_set(cache, "key1".to_string(), value.to_string());

        let result = native_byte_lru_cache_get(cache, "key1".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["found"], true);
        let val = parsed["value"].as_array().unwrap();
        assert_eq!(val.len(), 5);
    }

    #[test]
    fn test_lru_cache_eviction() {
        // Cache with only 10 bytes capacity
        let cache = native_byte_lru_cache_new(10.0);
        let v1 = serde_json::json!([1, 2, 3, 4, 5]); // 5 bytes
        let v2 = serde_json::json!([6, 7, 8, 9, 10]); // 5 bytes
        let v3 = serde_json::json!([11, 12, 13, 14, 15]); // 5 bytes -- should evict v1

        let cache = native_byte_lru_cache_set(cache, "k1".to_string(), v1.to_string());
        let cache = native_byte_lru_cache_set(cache, "k2".to_string(), v2.to_string());
        let cache = native_byte_lru_cache_set(cache, "k3".to_string(), v3.to_string());

        let parsed: serde_json::Value = serde_json::from_str(&cache).unwrap();
        let entries = parsed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2); // k1 was evicted

        // k1 should not be found
        let result = native_byte_lru_cache_get(cache, "k1".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["found"], false);
    }

    #[test]
    fn test_lru_cache_too_large() {
        let cache = native_byte_lru_cache_new(5.0);
        let value = serde_json::json!([1, 2, 3, 4, 5, 6]); // 6 bytes > 5 max
        let cache = native_byte_lru_cache_set(cache, "k1".to_string(), value.to_string());

        let parsed: serde_json::Value = serde_json::from_str(&cache).unwrap();
        assert_eq!(parsed["currentBytes"], 0);
        assert!(parsed["entries"].as_array().unwrap().is_empty());
    }
}