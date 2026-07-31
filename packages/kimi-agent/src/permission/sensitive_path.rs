/// Sensitive-path detection for the permission layer.
///
/// This is a faithful mirror of `kimi-native-tools::path_access::is_sensitive_file`
/// (which itself mirrors `packages/agent-core/src/tools/policies/sensitive.ts`).
/// It is duplicated here — rather than pulled in as a crate dependency — because
/// `kimi-agent` is deliberately kept free of a `kimi-native-tools` dependency
/// during the Phase 6 decoupling. The canonical implementation lives in
/// `packages/kimi-native-tools/src/path_access.rs`; when the planned
/// `kimi-shared` crate is extracted (see `RUST_MIGRATION_PLAN.md`, mid-term),
/// both copies should collapse into that single source of truth.
///
/// Semantics for the permission layer: a false positive only causes an extra
/// approval prompt, while a false negative silently exposes a secret. When the
/// two copies diverge, prefer matching the canonical `path_access.rs`.

/// Known sensitive basenames (case-insensitive match).
const SENSITIVE_BASENAMES: &[&str] = &[
    ".env",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "credentials",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "htpasswd",
    ".pgpass",
    ".git-credentials",
    ".ppk",
    ".p12",
    ".pfx",
    "kubeconfig",
];

/// Public-key basenames that are explicitly allowed (not sensitive).
const PUBLIC_KEY_BASENAMES: &[&str] = &["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];

/// Sensitive path suffixes (directory components + basename).
const SENSITIVE_PATH_SUFFIXES: &[&[&str]] = &[
    &[".aws", "credentials"],
    &[".gcp", "credentials"],
    &[".docker", "config.json"],
    &[".kube", "config"],
    &[".config", "kube", "config"],
    &[".ssh", "config"],
];

/// Sensitive key-file extensions.
const SENSITIVE_KEYFILE_EXTENSIONS: &[&str] = &[".ppk", ".p12", ".pfx", ".keystore", ".jks"];

/// Dot-variant suffixes (e.g. `.env.bak`, `id_rsa.old`).
const SENSITIVE_DOT_VARIANT_SUFFIXES: &[&str] = &[
    ".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp",
];

/// Sensitive basename prefixes for prefix-based matching (e.g. `id_rsa-*`).
const SENSITIVE_BASENAME_PREFIXES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

/// Exemptions: env-like files that are NOT sensitive.
const ENV_EXEMPTIONS: &[&str] = &[".env.example", ".env.sample", ".env.template"];

const ENV_PREFIX: &str = ".env.";

/// Check whether a path refers to a known sensitive file that should prompt
/// for approval before a Read/Write/Edit-style access.
///
/// Mirrors `kimi-native-tools::path_access::is_sensitive_file` — keep in sync.
pub fn is_sensitive_path(path: &str) -> bool {
    let path_lower = path.to_lowercase();
    let name = path_lower.rsplit(['/', '\\']).next().unwrap_or(&path_lower);

    // Exemptions first.
    if ENV_EXEMPTIONS.contains(&name) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.contains(&name) {
        return false;
    }

    // Exact basename match.
    if SENSITIVE_BASENAMES.contains(&name) {
        return true;
    }

    // .env.* prefix (e.g. .env.production).
    if name.starts_with(ENV_PREFIX) {
        return true;
    }

    // Prefix-based match (id_rsa-, id_rsa_, id_rsa.bak, etc.)
    for &prefix in SENSITIVE_BASENAME_PREFIXES {
        if name == prefix {
            return true;
        }
        if name.len() > prefix.len() && name.starts_with(prefix) {
            let suffix = &name[prefix.len()..];
            let next = suffix.chars().next().unwrap_or(' ');
            if next == '-' || next == '_' {
                return true;
            }
            if next == '.' && SENSITIVE_DOT_VARIANT_SUFFIXES.contains(&suffix) {
                return true;
            }
        }
    }

    // Path-suffix matching (e.g. .aws/credentials, .ssh/config).
    let normalized_path = path.replace('\\', "/");
    for &parts in SENSITIVE_PATH_SUFFIXES {
        let suffix = parts.join("/");
        if normalized_path.ends_with(&format!("/{}", suffix))
            || normalized_path.contains(&format!("/{}/", suffix))
        {
            return true;
        }
    }

    // Keyfile extension match.
    for &ext in SENSITIVE_KEYFILE_EXTENSIONS {
        if name.ends_with(ext) {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_files() {
        assert!(is_sensitive_path(".env"));
        assert!(is_sensitive_path("/project/.env"));
        assert!(is_sensitive_path(".env.production"));
        assert!(is_sensitive_path("config/.env.local"));
    }

    #[test]
    fn test_env_exemptions() {
        assert!(!is_sensitive_path(".env.example"));
        assert!(!is_sensitive_path(".env.sample"));
        assert!(!is_sensitive_path("/project/.env.template"));
    }

    #[test]
    fn test_private_keys() {
        assert!(is_sensitive_path("id_rsa"));
        assert!(is_sensitive_path("/home/u/.ssh/id_ed25519"));
        assert!(is_sensitive_path("id_rsa-prod"));
        assert!(is_sensitive_path("id_rsa.bak"));
        // Public keys are explicitly not sensitive.
        assert!(!is_sensitive_path("id_rsa.pub"));
        assert!(!is_sensitive_path("/home/u/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_credential_basenames() {
        assert!(is_sensitive_path("credentials"));
        assert!(is_sensitive_path(".npmrc"));
        assert!(is_sensitive_path(".netrc"));
        assert!(is_sensitive_path("kubeconfig"));
        assert!(is_sensitive_path(".git-credentials"));
    }

    #[test]
    fn test_path_suffixes() {
        assert!(is_sensitive_path("/home/u/.aws/credentials"));
        assert!(is_sensitive_path("C:\\Users\\u\\.ssh\\config"));
        assert!(is_sensitive_path("/home/u/.config/kube/config"));
        assert!(is_sensitive_path("/home/u/.docker/config.json"));
    }

    #[test]
    fn test_keyfile_extensions() {
        assert!(is_sensitive_path("server.keystore"));
        assert!(is_sensitive_path("cert.p12"));
        assert!(is_sensitive_path("bundle.pfx"));
    }

    #[test]
    fn test_ordinary_files_not_sensitive() {
        assert!(!is_sensitive_path("src/main.rs"));
        assert!(!is_sensitive_path("README.md"));
        assert!(!is_sensitive_path("package.json"));
        assert!(!is_sensitive_path("mycredentials.txt"));
        assert!(!is_sensitive_path("settings.json"));
    }
}
