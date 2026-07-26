//! Performance benchmarks for native tools.
//!
//! Run with: `cargo bench -p kimi-native-tools`
//!
//! These benchmarks measure the performance of the most critical native
//! operations using the public napi-exported functions.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use kimi_native_tools::*;

// ── Path access benchmarks (pure functions, no I/O) ──────────────────────────

fn bench_is_sensitive_file(c: &mut Criterion) {
    c.bench_function("is_sensitive_file_typical", |b| {
        b.iter(|| {
            let r1 = native_is_sensitive_file("/project/.env".into());
            let r2 = native_is_sensitive_file("/home/user/.ssh/id_rsa".into());
            let r3 = native_is_sensitive_file("/home/user/.ssh/id_rsa.pub".into());
            let r4 = native_is_sensitive_file("/project/src/main.rs".into());
            let r5 = native_is_sensitive_file("/home/user/.aws/credentials".into());
            let r6 = native_is_sensitive_file("/project/.env.production".into());
            let r7 = native_is_sensitive_file("/certs/server.p12".into());
            let r8 = native_is_sensitive_file("/project/package.json".into());
            let r9 = native_is_sensitive_file("/home/user/.git-credentials".into());
            let r10 = native_is_sensitive_file("/project/README.md".into());
            black_box((r1, r2, r3, r4, r5, r6, r7, r8, r9, r10));
        })
    });
}

fn bench_path_canonicalize(c: &mut Criterion) {
    c.bench_function("path_canonicalize", |b| {
        b.iter(|| {
            let r1 = native_path_canonicalize(
                "./src/main.rs".into(),
                "/workspace/project".into(),
                "posix".into(),
            );
            let r2 = native_path_canonicalize(
                "../../../etc/passwd".into(),
                "/workspace/project/sub/dir".into(),
                "posix".into(),
            );
            let r3 = native_path_canonicalize(
                "/absolute/path/file.txt".into(),
                "/workspace".into(),
                "posix".into(),
            );
            let r4 = native_path_is_within_directory(
                "/workspace/project/src/main.rs".into(),
                "/workspace/project".into(),
                "posix".into(),
            );
            let r5 = native_path_is_within_directory(
                "/workspace-evil/file.txt".into(),
                "/workspace".into(),
                "posix".into(),
            );
            black_box((r1, r2, r3, r4, r5));
        })
    });
}

fn bench_path_normalize(c: &mut Criterion) {
    c.bench_function("path_normalize_win32", |b| {
        b.iter(|| {
            let r1 = native_path_normalize_user_path("/cygdrive/c/path/to/file".into(), "win32".into());
            let r2 = native_path_normalize_user_path("/c/path".into(), "win32".into());
            let r3 = native_path_expand_user_path(
                "~/src".into(),
                Some("/home/user".into()),
                "posix".into(),
            );
            let r4 = native_path_expand_user_path("~".into(), Some("/home/user".into()), "posix".into());
            black_box((r1, r2, r3, r4));
        })
    });
}

// ── Globbing benchmarks ──────────────────────────────────────────────────────

fn bench_glob_matches(c: &mut Criterion) {
    c.bench_function("glob_matches_any", |b| {
        let patterns = vec![
            "*.ts".into(),
            "*.tsx".into(),
            "*.json".into(),
            "src/**".into(),
            "test/**".into(),
        ];
        b.iter(|| {
            let r1 = native_glob_matches_any(
                black_box(patterns.clone()),
                "/workspace/project/src/main.ts".into(),
            );
            let r2 = native_glob_matches_any(
                black_box(patterns.clone()),
                "/workspace/project/README.md".into(),
            );
            black_box((r1, r2));
        })
    });
}

// ── Permission rule parsing benchmarks ───────────────────────────────────────

fn bench_permission_parse(c: &mut Criterion) {
    c.bench_function("permission_parse_pattern", |b| {
        let patterns = vec![
            "Read".into(),
            "Read(/etc/**)".into(),
            "Bash(!rm * )".into(),
            "mcp__github__*".into(),
            "Write".into(),
        ];
        b.iter(|| {
            let results: Vec<String> = patterns.iter().map(|p: &String| {
                native_parse_permission_pattern(p.clone())
            }).collect();
            black_box(results);
        })
    });
}

fn bench_permission_match(c: &mut Criterion) {
    c.bench_function("permission_match_rule", |b| {
        let rule = serde_json::json!({"pattern": "read(/a.txt)"}).to_string();
        b.iter(|| {
            let r = native_match_permission_rule(
                black_box(rule.clone()),
                "read".into(),
                true,
                Some(true),
            );
            black_box(r);
        })
    });
}

// ── Token estimation benchmarks ──────────────────────────────────────────────

fn bench_token_estimation(c: &mut Criterion) {
    c.bench_function("estimate_tokens", |b| {
        let long_text = "The quick brown fox jumps over the lazy dog. ".repeat(1000);
        b.iter(|| {
            let r = native_estimate_tokens(black_box(long_text.clone()));
            black_box(r);
        })
    });
}

// ── Bench group ──────────────────────────────────────────────────────────────

criterion_group!(
    name = native_tools;
    config = Criterion::default()
        .sample_size(30)
        .measurement_time(std::time::Duration::from_secs(3))
        .warm_up_time(std::time::Duration::from_secs(1));
    targets =
        bench_is_sensitive_file,
        bench_path_canonicalize,
        bench_path_normalize,
        bench_glob_matches,
        bench_permission_parse,
        bench_permission_match,
        bench_token_estimation,
);
criterion_main!(native_tools);