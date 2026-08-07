//! Shared test helpers for kimi-sdk integration tests.

use std::sync::LazyLock;

use tokio::sync::MutexGuard;

/// Serializes tests that touch the process-global env vars (`KIMI_AGENT_HOME`,
/// `HOME`, `USERPROFILE`). Tests in the same binary run on parallel threads,
/// so a test that sets these would race another test's engine reads. Every
/// caller must hold the returned guard for the whole test.
pub static ISOLATE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// A fresh isolated engine home, unique per test.
///
/// Sets `KIMI_AGENT_HOME` for the session store AND isolates the config
/// search/write paths: `config/get` reads the user-level
/// `~/.kimi-code/config.toml` (a dev machine is typically logged in, leaking
/// `providers.kimi.apiKey` into "fresh" assertions) and `config/set` writes
/// it back (a test login or config patch would clobber the real token — and,
/// via the cwd-relative fallback, could drop a key-bearing config into a
/// project directory). Pointing HOME/USERPROFILE at the isolated home
/// resolves the user-level config paths inside it; the explicit overrides are
/// cleared so nothing can redirect the read/write elsewhere.
///
/// Returns the isolation guard alongside the home path; the guard must be
/// held for the duration of the test (a `tokio::sync::MutexGuard`, so it is
/// Send and may be held across awaits).
pub async fn isolate_home(tag: &str) -> (MutexGuard<'static, ()>, std::path::PathBuf) {
    let guard = ISOLATE_LOCK.lock().await;
    let home = std::env::temp_dir().join(format!("kimi-sdk-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);
    std::env::remove_var("KIMI_CONFIG_PATH");
    std::env::remove_var("KIMI_CODE_HOME");
    std::env::set_var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }, &home);
    // Seed a minimal user-level config with one mock provider: several tests
    // (list_models aliases, config round-trips) exercise the merged-config
    // surface and need a non-empty provider set. `providers.mock` carries no
    // real credentials and no `kimi` provider, so the auth "fresh: not
    // logged in" assertions stay valid.
    let config_dir = home.join(".kimi-code");
    std::fs::create_dir_all(&config_dir).expect("mkdir config dir");
    std::fs::write(
        config_dir.join("config.toml"),
        "defaultModel = \"mock-model\"\n\n[models.mock-alias]\nprovider = \"mock\"\nmodel = \"mock-model\"\n\n[providers.mock]\ntype = \"openai\"\napiKey = \"test-key\"\nbaseUrl = \"http://127.0.0.1:9999/v1\"\n",
    )
    .expect("seed config");
    (guard, home)
}
