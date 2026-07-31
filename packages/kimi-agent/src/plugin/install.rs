//! Plugin installer — download, extract, and register plugins.
//!
//! Supports installation from GitHub repositories, remote zip URLs,
//! and local filesystem paths.

use std::path::Path;

use crate::plugin::manifest::PluginManifest;
use crate::plugin::store::PluginStore;
use crate::plugin::types::*;

/// Install a plugin from a GitHub repository.
///
/// Downloads the repository's default branch (or a specific tag) as a zip
/// archive from GitHub's archive API, extracts it, reads the plugin.json
/// manifest, and registers the plugin in the store.
pub async fn install_from_github(
    repo: &str,
    tag: Option<&str>,
    plugins_dir: &Path,
    store: &PluginStore,
) -> Result<PluginRecord, String> {
    // Validate repo format: "owner/name"
    if !repo.contains('/') {
        return Err(format!("Invalid GitHub repo format: {repo}. Expected \"owner/repo\"."));
    }

    // Build the download URL
    let url = match tag {
        Some(t) => format!("https://github.com/{repo}/archive/refs/tags/{t}.zip"),
        None => format!("https://github.com/{repo}/archive/HEAD.zip"),
    };

    let plugin_id = format!("github:{repo}");
    let dest_dir = plugins_dir.join(&sanitize_plugin_name(repo));

    // Download the zip archive
    let zip_data = download_url(&url).await?;

    // Extract to destination
    extract_zip(&zip_data, &dest_dir)?;

    // Find and parse plugin.json
    let manifest = find_and_parse_manifest(&dest_dir)?;

    let record = manifest.to_record(plugin_id, PluginSource::Github {
        repo: repo.to_string(),
        tag: tag.map(|s| s.to_string()),
    });

    store.upsert(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Install a plugin from a remote zip URL.
pub async fn install_from_url(
    url: &str,
    plugins_dir: &Path,
    store: &PluginStore,
) -> Result<PluginRecord, String> {
    let plugin_id = format!("url:{}", url);
    let dest_dir = plugins_dir.join(&sanitize_plugin_name(url));

    let zip_data = download_url(url).await?;
    extract_zip(&zip_data, &dest_dir)?;

    let manifest = find_and_parse_manifest(&dest_dir)?;

    let record = manifest.to_record(plugin_id, PluginSource::Url {
        url: url.to_string(),
    });

    store.upsert(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Install a plugin from a local filesystem path.
pub fn install_from_local(
    path: &str,
    store: &PluginStore,
) -> Result<PluginRecord, String> {
    let plugin_path = Path::new(path);
    if !plugin_path.exists() {
        return Err(format!("Plugin path does not exist: {path}"));
    }

    let manifest = if plugin_path.is_dir() {
        // Directory: look for plugin.json inside
        find_and_parse_manifest(plugin_path)?
    } else if plugin_path.is_file() {
        // Single file: read as plugin.json
        PluginManifest::from_file(plugin_path)?
    } else {
        return Err(format!("Invalid plugin path: {path}"));
    };

    let plugin_id = format!("local:{}", path);
    let record = manifest.to_record(plugin_id, PluginSource::Local {
        path: path.to_string(),
    });

    store.upsert(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Download a URL and return the raw bytes.
async fn download_url(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to download {url}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download {url}: HTTP {}",
            response.status()
        ));
    }

    response.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Failed to read response body: {e}"))
}

/// Extract a zip archive to a destination directory.
fn extract_zip(zip_data: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(zip_data);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Failed to open zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;

        let Some(entry_name) = file.enclosed_name() else {
            continue;
        };

        let target = dest.join(entry_name);
        let parent = target.parent().unwrap_or(dest);

        if file.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("Failed to create directory {target:?}: {e}"))?;
        } else {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {parent:?}: {e}"))?;

            let mut out = std::fs::File::create(&target)
                .map_err(|e| format!("Failed to create file {target:?}: {e}"))?;

            std::io::copy(&mut file, &mut out)
                .map_err(|e| format!("Failed to extract file {target:?}: {e}"))?;
        }
    }

    Ok(())
}

/// Find and parse plugin.json from an extracted directory.
fn find_and_parse_manifest(dir: &Path) -> Result<PluginManifest, String> {
    // Try direct path
    let direct = dir.join("plugin.json");
    if direct.exists() {
        return PluginManifest::from_file(&direct);
    }

    // Try first subdirectory (GitHub archives have a top-level dir)
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let candidate = path.join("plugin.json");
                if candidate.exists() {
                    return PluginManifest::from_file(&candidate);
                }
            }
        }
    }

    Err(format!("plugin.json not found in {dir:?}"))
}

/// Sanitize a name for use as a directory name.
fn sanitize_plugin_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    #[test]
    fn test_sanitize_plugin_name() {
        assert_eq!(sanitize_plugin_name("my-org/my-plugin"), "my-org_my-plugin");
        assert_eq!(sanitize_plugin_name("hello"), "hello");
        assert_eq!(sanitize_plugin_name("a/b/c"), "a_b_c");
    }

    #[test]
    fn test_install_from_local_nonexistent() {
        let store = PluginStore::new(SqliteStore::in_memory().unwrap());
        store.init().unwrap();
        let result = install_from_local("/nonexistent/path/plugin.json", &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not exist"));
    }

    #[test]
    fn test_install_from_local_with_dir() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("my-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();

        let manifest = r#"{
            "name": "test-plugin",
            "version": "1.0.0",
            "description": "A test plugin",
            "skills": [
                {"name": "test-skill", "description": "A skill", "file": "skill.md"}
            ]
        }"#;
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();

        let store = PluginStore::new(SqliteStore::in_memory().unwrap());
        store.init().unwrap();

        let result = install_from_local(plugin_dir.to_str().unwrap(), &store);
        assert!(result.is_ok(), "install failed: {:?}", result.err());
        let record = result.unwrap();
        assert_eq!(record.name, "test-plugin");
        assert_eq!(record.skills.len(), 1);
    }

    #[test]
    fn test_install_from_local_with_file() {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = dir.path().join("plugin.json");

        let manifest = r#"{
            "name": "file-plugin",
            "version": "2.0.0",
            "description": "Installed from a file"
        }"#;
        std::fs::write(&manifest_path, manifest).unwrap();

        let store = PluginStore::new(SqliteStore::in_memory().unwrap());
        store.init().unwrap();

        let result = install_from_local(manifest_path.to_str().unwrap(), &store);
        assert!(result.is_ok(), "install failed: {:?}", result.err());
        let record = result.unwrap();
        assert_eq!(record.name, "file-plugin");
        assert_eq!(record.version, "2.0.0");
    }
}