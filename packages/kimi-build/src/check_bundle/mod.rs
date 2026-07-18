/// Bundle checker — verifies that a bundled JS file has no unresolved
/// external requires or imports.
///
/// Ported from `apps/kimi-code/scripts/native/check-bundle.mjs`.

use std::collections::HashSet;
use std::path::Path;

use regex::Regex;

/// The set of allowed external specifiers.
fn builtin_modules() -> HashSet<&'static str> {
    let mut s = HashSet::new();
    for name in &[
        "assert", "assert/strict", "buffer", "child_process", "cluster",
        "console", "constants", "crypto", "dgram", "diagnostics_channel",
        "dns", "dns/promises", "domain", "events", "fs", "fs/promises",
        "http", "http2", "https", "inspector", "inspector/promises",
        "module", "net", "os", "path", "path/posix", "path/win32",
        "perf_hooks", "process", "punycode", "querystring", "readline",
        "readline/promises", "repl", "stream", "stream/consumers",
        "stream/promises", "stream/web", "string_decoder", "timers",
        "timers/promises", "tls", "trace_events", "tty", "url",
        "util", "util/types", "v8", "vm", "worker_threads", "zlib",
    ] {
        s.insert(*name);
    }
    // Also add node: prefixed versions
    for name in &[
        "node:assert", "node:assert/strict", "node:buffer", "node:child_process",
        "node:cluster", "node:console", "node:constants", "node:crypto",
        "node:dgram", "node:diagnostics_channel", "node:dns", "node:dns/promises",
        "node:domain", "node:events", "node:fs", "node:fs/promises",
        "node:http", "node:http2", "node:https", "node:inspector",
        "node:inspector/promises", "node:module", "node:net", "node:os",
        "node:path", "node:path/posix", "node:path/win32", "node:perf_hooks",
        "node:process", "node:punycode", "node:querystring", "node:readline",
        "node:readline/promises", "node:repl", "node:stream",
        "node:stream/consumers", "node:stream/promises", "node:stream/web",
        "node:string_decoder", "node:timers", "node:timers/promises",
        "node:tls", "node:trace_events", "node:tty", "node:url",
        "node:util", "node:util/types", "node:v8", "node:vm",
        "node:worker_threads", "node:zlib",
    ] {
        s.insert(*name);
    }
    s
}

fn optional_runtime_requires() -> HashSet<&'static str> {
    let mut s = HashSet::new();
    for name in &[
        "ajv-formats/dist/formats",
        "ajv/dist/runtime/validation_error",
        "bufferutil",
        "canvas",
        "chokidar",
        "cpu-features",
        "fast-json-stringify/lib/serializer",
        "fast-json-stringify/lib/validator",
        "utf-8-validate",
        "@moonshot-ai/server",
        "@moonshot-ai/kimi-native-tools",
        "@moonshot-ai/kimi-i18n",
        "@moonshot-ai/kimi-agent",
    ] {
        s.insert(*name);
    }
    s
}

fn optional_relative_runtime_requires() -> HashSet<&'static str> {
    let mut s = HashSet::new();
    s.insert("./crypto/build/Release/sshcrypto.node");
    s
}

fn is_allowed_specifier(
    specifier: &str,
    builtins: &HashSet<&'static str>,
    optional: &HashSet<&'static str>,
) -> bool {
    if specifier.starts_with("node:") || builtins.contains(specifier) {
        return true;
    }
    if optional.contains(specifier) {
        return true;
    }
    false
}

/// Check if the character at position `pos-1` in `line` is NOT a word character or dot.
/// This replaces the `(?<![.\w])` lookbehind assertion.
fn has_valid_boundary(line: &str, pos: usize) -> bool {
    if pos == 0 {
        return true;
    }
    let prev = line.as_bytes()[pos - 1];
    !(prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'.')
}

/// Find all matches of `re` in `line` that have a valid boundary before them.
fn find_matches<'t>(line: &'t str, re: &Regex) -> Vec<&'t str> {
    re.find_iter(line)
        .filter(|m| has_valid_boundary(line, m.start()))
        .map(|m| m.as_str())
        .collect()
}

/// Extract the specifier string from a require/import match.
/// Patterns: require("specifier"), require('specifier'), import("specifier"), etc.
fn extract_specifier(match_str: &str) -> Option<&str> {
    // Find the first quote character
    let quote_start = match_str.find(['"', '\''])?;
    let quote = match_str.as_bytes()[quote_start];
    // Find the matching closing quote
    let rest = &match_str[quote_start + 1..];
    let quote_end = rest.find(quote as char)?;
    Some(&rest[..quote_end])
}

/// Check a bundled JS file for unresolved requires/imports.
pub fn check_bundle(path: &str) -> anyhow::Result<()> {
    let bundle_path = Path::new(path);
    let text = std::fs::read_to_string(bundle_path)
        .map_err(|e| anyhow::anyhow!("Failed to read '{}': {}", path, e))?;

    let builtins = builtin_modules();
    let optional = optional_runtime_requires();
    let optional_relative = optional_relative_runtime_requires();

    // Regex patterns without lookbehind (we check boundaries manually)
    let require_re =
        Regex::new(r#"require\s*\(\s*["'][^"']+["']\s*\)"#)
            .map_err(|e| anyhow::anyhow!("Failed to compile require regex: {e}"))?;
    let import_re =
        Regex::new(r#"import\s*\(\s*["'][^"']+["']\s*\)"#)
            .map_err(|e| anyhow::anyhow!("Failed to compile import regex: {e}"))?;
    let from_re =
        Regex::new(r#"\bfrom\s+["'][^"']+["']"#)
            .map_err(|e| anyhow::anyhow!("Failed to compile from regex: {e}"))?;

    let mut errors: Vec<String> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with('*')
            || line.starts_with("//")
            || line.starts_with("/*")
        {
            continue;
        }

        // Check require() calls
        for m in find_matches(line, &require_re) {
            let Some(specifier) = extract_specifier(m) else { continue; };
            if specifier.starts_with('.') || specifier.starts_with('/') {
                if !optional_relative.contains(specifier) {
                    errors.push(format!("relative require remains: {specifier}"));
                }
                continue;
            }
            if !is_allowed_specifier(specifier, &builtins, &optional) {
                errors.push(format!("external require remains: {specifier}"));
            }
        }

        // Check dynamic import() calls
        for m in find_matches(line, &import_re) {
            let Some(specifier) = extract_specifier(m) else { continue; };
            if specifier.starts_with('.') || specifier.starts_with('/') {
                errors.push(format!("relative dynamic import remains: {specifier}"));
                continue;
            }
            if !is_allowed_specifier(specifier, &builtins, &optional) {
                errors.push(format!("external dynamic import remains: {specifier}"));
            }
        }

        // Check import ... from statements
        if line.starts_with("import ") {
            for m in find_matches(line, &from_re) {
                let Some(specifier) = extract_specifier(m) else { continue; };
                if specifier.starts_with('.') || specifier.starts_with('/') {
                    errors.push(format!("relative import remains: {specifier}"));
                    continue;
                }
                if !is_allowed_specifier(specifier, &builtins, &optional) {
                    errors.push(format!("external import remains: {specifier}"));
                }
            }
        }
    }

    if !errors.is_empty() {
        eprintln!("Native JS bundle check failed for {path}:");
        for error in &errors {
            eprintln!("- {error}");
        }
        anyhow::bail!("Bundle check failed with {} error(s)", errors.len());
    }

    println!("Bundle check passed for {path}");
    Ok(())
}