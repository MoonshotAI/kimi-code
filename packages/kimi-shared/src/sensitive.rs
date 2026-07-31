//! Sensitive-file detection for the permission / tool-access layers.
//!
//! Shared source of truth for:
//!   - `kimi-native-tools::path_access::is_sensitive_file` /
//!     `looks_like_private_key_content` (napi bridge)
//!   - `kimi-agent::permission::sensitive_path::is_sensitive_path`
//!     (main engine — previously a "faithful mirror" of the native copy)
//!
//! The implementation mirrors `packages/agent-core/src/tools/policies/sensitive.ts`.
//! The native copy is the canonical logic (it also carries the
//! `looks_like_private_key_content` content-sniff helper, which the agent
//! mirror did not need); the agent mirror's semantics were identical. When the
//! two historical copies diverge in a future fix, the shared copy here is the
//! single source of truth and both consumers re-export it.
//!
//! Semantics for the permission layer: a false positive only causes an extra
//! approval prompt, while a false negative silently exposes a secret. When in
//! doubt, prefer matching the canonical `path_access.rs` behavior.

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

/// Check whether a path refers to a known sensitive file that should be
/// blocked (or prompt for approval) before a Read/Write/Edit-style access.
///
/// Matches the TS implementation in `packages/agent-core/src/tools/policies/sensitive.ts`.
pub fn is_sensitive_file(path: &str) -> bool {
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

/// Check whether a file's content looks like a private key (content-sniff).
pub fn looks_like_private_key_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    trimmed.starts_with("-----BEGIN RSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN EC PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN DSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN PGP PRIVATE KEY BLOCK-----")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── From kimi-native-tools::path_access tests ──────────────────────────

    #[test]
    fn test_is_sensitive_file_dot_env() {
        assert!(is_sensitive_file("/project/.env"));
        assert!(is_sensitive_file("/project/.env.production"));
    }

    #[test]
    fn test_is_sensitive_file_dot_env_exemptions() {
        assert!(!is_sensitive_file("/project/.env.example"));
        assert!(!is_sensitive_file("/project/.env.sample"));
        assert!(!is_sensitive_file("/project/.env.template"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_keys() {
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ecdsa"));
    }

    #[test]
    fn test_is_sensitive_file_public_keys_allowed() {
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_key_variants() {
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.bak"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.old"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa_copy"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa-backup"));
    }

    #[test]
    fn test_is_sensitive_file_git_credentials() {
        assert!(is_sensitive_file("/project/.git-credentials"));
    }

    #[test]
    fn test_is_sensitive_file_path_suffix() {
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/home/user/.ssh/config"));
        assert!(is_sensitive_file("/home/user/.docker/config.json"));
    }

    #[test]
    fn test_is_sensitive_file_keyfile_extensions() {
        assert!(is_sensitive_file("/certs/server.p12"));
        assert!(is_sensitive_file("/certs/truststore.jks"));
    }

    #[test]
    fn test_is_sensitive_file_normal_file_not_sensitive() {
        assert!(!is_sensitive_file("/project/src/main.rs"));
        assert!(!is_sensitive_file("/project/package.json"));
        assert!(!is_sensitive_file("/project/README.md"));
    }

    #[test]
    fn test_is_sensitive_file_dot_env_variants() {
        assert!(is_sensitive_file("/project/.env.production"));
        assert!(is_sensitive_file("/project/.env.development.local"));
        assert!(!is_sensitive_file("/project/.env.example"));
        assert!(!is_sensitive_file("/project/.env.sample"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_key_variant_formats() {
        // Rename-shielded variants
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.backup"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa_copy"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519-old"));
        // Public keys are allowed
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        // Unrelated files with similar prefix should not match
        assert!(!is_sensitive_file("/home/user/id_rsafoo.txt"));
    }

    #[test]
    fn test_is_sensitive_file_path_suffix_edge_cases() {
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/home/user/.ssh/config"));
        // Deep path with suffix
        assert!(is_sensitive_file("/home/user/project/.aws/credentials"));
        // Not sensitive if just directory name matches
        assert!(!is_sensitive_file("/home/user/.aws"));
    }

    #[test]
    fn test_is_sensitive_file_npmrc_and_netrc() {
        assert!(is_sensitive_file("/project/.npmrc"));
        assert!(is_sensitive_file("/project/.netrc"));
        assert!(is_sensitive_file("/project/.pypirc"));
    }

    #[test]
    fn test_is_sensitive_file_kubeconfig() {
        assert!(is_sensitive_file("/home/user/.kube/config"));
        assert!(is_sensitive_file("/home/user/.config/kube/config"));
    }

    #[test]
    fn test_is_sensitive_file_keyfile_extensions_detailed() {
        assert!(is_sensitive_file("/certs/server.p12"));
        assert!(is_sensitive_file("/certs/truststore.jks"));
        assert!(is_sensitive_file("/certs/keystore.jks"));
        assert!(is_sensitive_file("/certs/domain.pfx"));
    }

    #[test]
    fn test_is_sensitive_file_pgpass_and_htpasswd() {
        assert!(is_sensitive_file("/home/user/.pgpass"));
        assert!(!is_sensitive_file("/etc/nginx/.htpasswd")); // htpasswd is lowercase without dot prefix
        assert!(is_sensitive_file("/etc/nginx/htpasswd"));
    }

    #[test]
    fn test_looks_like_private_key_content() {
        assert!(looks_like_private_key_content("-----BEGIN RSA PRIVATE KEY-----\nbase64data"));
        assert!(looks_like_private_key_content("  \n-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(!looks_like_private_key_content("public data"));
        assert!(!looks_like_private_key_content(""));
    }

    #[test]
    fn test_looks_like_private_key_content_all_formats() {
        assert!(looks_like_private_key_content("-----BEGIN RSA PRIVATE KEY-----\nMIIEpA"));
        assert!(looks_like_private_key_content("-----BEGIN EC PRIVATE KEY-----\nMHQCAQ"));
        assert!(looks_like_private_key_content("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn"));
        assert!(looks_like_private_key_content("-----BEGIN DSA PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN ENCRYPTED PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN PGP PRIVATE KEY BLOCK-----"));
    }

    #[test]
    fn test_looks_like_private_key_content_negative() {
        assert!(!looks_like_private_key_content(""));
        assert!(!looks_like_private_key_content("public data"));
        assert!(!looks_like_private_key_content("-----BEGIN CERTIFICATE-----"));
        assert!(!looks_like_private_key_content("-----BEGIN PUBLIC KEY-----"));
    }

    // ── From kimi-agent::permission::sensitive_path tests ──────────────────

    #[test]
    fn test_env_files() {
        assert!(is_sensitive_file(".env"));
        assert!(is_sensitive_file("/project/.env"));
        assert!(is_sensitive_file(".env.production"));
        assert!(is_sensitive_file("config/.env.local"));
    }

    #[test]
    fn test_env_exemptions() {
        assert!(!is_sensitive_file(".env.example"));
        assert!(!is_sensitive_file(".env.sample"));
        assert!(!is_sensitive_file("/project/.env.template"));
    }

    #[test]
    fn test_private_keys() {
        assert!(is_sensitive_file("id_rsa"));
        assert!(is_sensitive_file("/home/u/.ssh/id_ed25519"));
        assert!(is_sensitive_file("id_rsa-prod"));
        assert!(is_sensitive_file("id_rsa.bak"));
        // Public keys are explicitly not sensitive.
        assert!(!is_sensitive_file("id_rsa.pub"));
        assert!(!is_sensitive_file("/home/u/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_credential_basenames() {
        assert!(is_sensitive_file("credentials"));
        assert!(is_sensitive_file(".npmrc"));
        assert!(is_sensitive_file(".netrc"));
        assert!(is_sensitive_file("kubeconfig"));
        assert!(is_sensitive_file(".git-credentials"));
    }

    #[test]
    fn test_path_suffixes() {
        assert!(is_sensitive_file("/home/u/.aws/credentials"));
        assert!(is_sensitive_file("C:\\Users\\u\\.ssh\\config"));
        assert!(is_sensitive_file("/home/u/.config/kube/config"));
        assert!(is_sensitive_file("/home/u/.docker/config.json"));
    }

    #[test]
    fn test_keyfile_extensions() {
        assert!(is_sensitive_file("server.keystore"));
        assert!(is_sensitive_file("cert.p12"));
        assert!(is_sensitive_file("bundle.pfx"));
    }

    #[test]
    fn test_ordinary_files_not_sensitive() {
        assert!(!is_sensitive_file("src/main.rs"));
        assert!(!is_sensitive_file("README.md"));
        assert!(!is_sensitive_file("package.json"));
        assert!(!is_sensitive_file("mycredentials.txt"));
        assert!(!is_sensitive_file("settings.json"));
    }
}
