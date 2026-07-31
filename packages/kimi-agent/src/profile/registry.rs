//! Agent-profile registry — the extension point for agent-file contributions.
//!
//! Mirrors upstream `agent-core-v2/src/app/agentProfileCatalog/` (#2366): a
//! registry where any contributor registers agent-directory roots keyed by
//! (`source_id`, `workspace_key`). Re-registering the same key replaces the
//! previous entry — dedup per source is the only dedup this layer performs.
//! [`AgentProfileRegistry::catalog`] projects the stored roots into
//! [`AgentFileDefinition`]s via [`discover_agent_files`], merging same-name
//! definitions by source tier (`plugin` < `user` < `extra` < `project` <
//! `explicit`) with later registrations winning ties. Every mutation fires
//! the `on_changed` listeners so the host can re-project.
//!
//! Plugin wiring (the main agent does the actual hookup, not this module):
//! plugin agent roots come from [`crate::plugin::injector::collect_plugin_injections`]
//! — `PluginInjection.agent_roots`, where each [`crate::plugin::types::PluginAgent`]
//! carries a directory path. Register them as
//! `registry.register("plugin", None, vec![agent.path.clone()])`; discovery
//! then scans them with [`AgentFileSource::Plugin`], the lowest-priority tier,
//! so workspace, user, and explicit agents override plugin-provided ones.
//! Register the remaining roots under their canonical ids (see [`SOURCE_PLUGIN`]
//! and friends) to join the same projection.

use std::collections::HashMap;

use crate::profile::agent_file::{AgentFileDefinition, AgentFileSource, discover_agent_files};

/// Canonical source id for plugin-provided agent roots.
pub const SOURCE_PLUGIN: &str = "plugin";
/// Canonical source id for user-scope agent roots.
pub const SOURCE_USER: &str = "user";
/// Canonical source id for extra-scope agent roots.
pub const SOURCE_EXTRA: &str = "extra";
/// Canonical source id for project-scope agent roots (`workspace` is an alias).
pub const SOURCE_PROJECT: &str = "project";
/// Canonical source id for explicitly-referenced agent files.
pub const SOURCE_EXPLICIT: &str = "explicit";

/// One registered contribution: the directories to scan for agent files.
///
/// `workspace_key` tags a workspace-local contribution so the same `source_id`
/// can coexist across handlers; `None` marks a global one.
#[derive(Debug, Clone)]
pub struct AgentProfileRegistration {
    pub source_id: String,
    pub workspace_key: Option<String>,
    pub roots: Vec<String>,
}

/// Payload fired to `on_changed` listeners for each mutation, identifying the
/// affected contribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfileRegistryChange {
    pub source_id: String,
    pub workspace_key: Option<String>,
}

#[derive(Debug)]
struct Entry {
    registration: AgentProfileRegistration,
    /// Registration order, used to break same-priority name ties toward the
    /// later registration.
    sequence: u64,
}

/// The registry of the contribution/registry/catalog extension-point pattern
/// for agent profiles (upstream `AgentProfileRegistryService`).
///
/// Pure storage over (source_id, workspace_key) keys: merging, name dedup,
/// and override rules live in [`AgentProfileRegistry::catalog`], never here.
pub struct AgentProfileRegistry {
    storage: HashMap<(String, Option<String>), Entry>,
    next_sequence: u64,
    listeners: Vec<Box<dyn Fn(&AgentProfileRegistryChange) + Send + Sync>>,
}

impl AgentProfileRegistry {
    pub fn new() -> Self {
        Self {
            storage: HashMap::new(),
            next_sequence: 0,
            listeners: Vec::new(),
        }
    }

    /// Register (or re-register) a contribution. The same (source_id,
    /// workspace_key) pair replaces the previous entry's roots, which is the
    /// registry's only dedup. Fires `on_changed` with the affected key.
    pub fn register(
        &mut self,
        source_id: impl Into<String>,
        workspace_key: Option<&str>,
        roots: Vec<String>,
    ) {
        let source_id = source_id.into();
        let key = (source_id.clone(), workspace_key.map(str::to_string));
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.storage.insert(
            key,
            Entry {
                registration: AgentProfileRegistration {
                    source_id: source_id.clone(),
                    workspace_key: workspace_key.map(str::to_string),
                    roots,
                },
                sequence,
            },
        );
        self.emit_change(&AgentProfileRegistryChange {
            source_id,
            workspace_key: workspace_key.map(str::to_string),
        });
    }

    /// Remove the contribution registered under the given key. Removing a
    /// missing entry is a silent no-op, like upstream.
    pub fn unregister(&mut self, source_id: &str, workspace_key: Option<&str>) {
        let key = (source_id.to_string(), workspace_key.map(str::to_string));
        if self.storage.remove(&key).is_none() {
            return;
        }
        self.emit_change(&AgentProfileRegistryChange {
            source_id: source_id.to_string(),
            workspace_key: workspace_key.map(str::to_string),
        });
    }

    /// Subscribe to mutations. Every `register` / `unregister` invokes each
    /// listener with the affected (source_id, workspace_key), so the host can
    /// re-project its catalog on change events.
    pub fn on_changed(&mut self, listener: impl Fn(&AgentProfileRegistryChange) + Send + Sync + 'static) {
        self.listeners.push(Box::new(listener));
    }

    /// The stored registrations, in registration order.
    pub fn entries(&self) -> Vec<&AgentProfileRegistration> {
        let mut entries: Vec<&Entry> = self.storage.values().collect();
        entries.sort_by_key(|entry| entry.sequence);
        entries
            .into_iter()
            .map(|entry| &entry.registration)
            .collect()
    }

    /// Project the stored roots into the merged agent-file catalog.
    ///
    /// Scans every registered root with [`discover_agent_files`] using the
    /// source tag derived from each registration's `source_id`, then dedups by
    /// agent name: the highest-priority source wins (`plugin` < `user` <
    /// `extra` < `project` < `explicit`), ties going to the later
    /// registration. Unreadable roots and unparsable files are skipped, as in
    /// discovery. The output is sorted by agent name for a stable projection.
    pub fn catalog(&self) -> Vec<AgentFileDefinition> {
        let mut best: HashMap<String, (u8, u64, AgentFileDefinition)> = HashMap::new();
        for entry in self.storage.values() {
            let source = file_source_for(&entry.registration.source_id);
            let roots: Vec<&str> = entry.registration.roots.iter().map(String::as_str).collect();
            let (agents, _skipped) = discover_agent_files(&roots, source);
            for def in agents {
                let candidate = (source_priority(source), entry.sequence, def);
                let name = candidate.2.name.clone();
                match best.get(&name) {
                    Some(current) if (current.0, current.1) >= (candidate.0, candidate.1) => {}
                    _ => {
                        best.insert(name, candidate);
                    }
                }
            }
        }
        let mut names: Vec<String> = best.keys().cloned().collect();
        names.sort();
        names
            .into_iter()
            .filter_map(|name| best.remove(&name).map(|(_, _, def)| def))
            .collect()
    }

    fn emit_change(&self, change: &AgentProfileRegistryChange) {
        for listener in &self.listeners {
            listener(change);
        }
    }
}

impl Default for AgentProfileRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// The discovery source tag for a registry source id. The five canonical ids
/// map to their [`AgentFileSource`]; `workspace` is a project alias
/// (workspace-local agent files live in the project tree); unknown ids scan
/// as `Project`, the conservative middle tier.
fn file_source_for(source_id: &str) -> AgentFileSource {
    match source_id {
        SOURCE_PLUGIN => AgentFileSource::Plugin,
        SOURCE_USER => AgentFileSource::User,
        SOURCE_EXTRA => AgentFileSource::Extra,
        SOURCE_PROJECT | "workspace" => AgentFileSource::Project,
        SOURCE_EXPLICIT => AgentFileSource::Explicit,
        _ => AgentFileSource::Project,
    }
}

/// Source tier used to adjudicate same-name merges; later tiers override
/// earlier ones.
fn source_priority(source: AgentFileSource) -> u8 {
    match source {
        AgentFileSource::Plugin => 1,
        AgentFileSource::User => 2,
        AgentFileSource::Extra => 3,
        AgentFileSource::Project => 4,
        AgentFileSource::Explicit => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_agent(dir: &std::path::Path, name: &str, description: &str) -> String {
        let path = dir.join(format!("{name}.md"));
        std::fs::write(
            &path,
            format!("---\nname: {name}\ndescription: {description}\n---\nbody\n"),
        )
        .unwrap();
        path.to_string_lossy().to_string()
    }

    fn root_str(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    #[test]
    fn same_source_reregistration_replaces_roots() {
        let mut registry = AgentProfileRegistry::new();
        let dir_a = tempfile::tempdir().unwrap();
        write_agent(dir_a.path(), "alpha", "from a");
        let dir_b = tempfile::tempdir().unwrap();
        write_agent(dir_b.path(), "beta", "from b");

        registry.register("user", None, vec![root_str(&dir_a)]);
        assert_eq!(registry.entries().len(), 1);
        registry.register("user", None, vec![root_str(&dir_b)]);
        assert_eq!(registry.entries().len(), 1);
        assert_eq!(registry.entries()[0].roots, vec![root_str(&dir_b)]);

        let catalog = registry.catalog();
        let names: Vec<&str> = catalog.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["beta"]);
    }

    #[test]
    fn workspace_keys_coexist_and_reregistration_is_keyed() {
        let mut registry = AgentProfileRegistry::new();
        let dir_a = tempfile::tempdir().unwrap();
        write_agent(dir_a.path(), "alpha", "wd_a agent");
        let dir_b = tempfile::tempdir().unwrap();
        write_agent(dir_b.path(), "beta", "wd_b agent");

        registry.register("project", Some("wd_a"), vec![root_str(&dir_a)]);
        registry.register("project", Some("wd_b"), vec![root_str(&dir_b)]);
        assert_eq!(registry.entries().len(), 2);

        // Re-registering one key replaces only that key's roots.
        std::fs::remove_file(dir_a.path().join("alpha.md")).unwrap();
        write_agent(dir_a.path(), "alpha2", "wd_a agent v2");
        registry.register("project", Some("wd_a"), vec![root_str(&dir_a)]);
        assert_eq!(registry.entries().len(), 2);
        let catalog = registry.catalog();
        let names: Vec<&str> = catalog.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["alpha2", "beta"]);
    }

    #[test]
    fn higher_priority_source_wins_same_name() {
        let mut registry = AgentProfileRegistry::new();
        let plugin_dir = tempfile::tempdir().unwrap();
        write_agent(plugin_dir.path(), "shared", "plugin version");
        let project_dir = tempfile::tempdir().unwrap();
        write_agent(project_dir.path(), "shared", "project version");

        registry.register("plugin", None, vec![root_str(&plugin_dir)]);
        registry.register("project", None, vec![root_str(&project_dir)]);

        let catalog = registry.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].description, "project version");
        assert_eq!(catalog[0].source, AgentFileSource::Project);
    }

    #[test]
    fn explicit_beats_every_lower_tier_regardless_of_order() {
        let mut registry = AgentProfileRegistry::new();
        let mut dirs = Vec::new();
        for (source, marker) in [
            ("project", "project version"),
            ("plugin", "plugin version"),
            ("explicit", "explicit version"),
            ("user", "user version"),
            ("extra", "extra version"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            write_agent(dir.path(), "shared", marker);
            registry.register(source, None, vec![root_str(&dir)]);
            dirs.push(dir);
        }
        let _dirs = dirs;

        let catalog = registry.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].description, "explicit version");
        assert_eq!(catalog[0].source, AgentFileSource::Explicit);
    }

    #[test]
    fn same_priority_tie_breaks_to_later_registration() {
        let mut registry = AgentProfileRegistry::new();
        let dir_a = tempfile::tempdir().unwrap();
        write_agent(dir_a.path(), "shared", "plugin a");
        let dir_b = tempfile::tempdir().unwrap();
        write_agent(dir_b.path(), "shared", "plugin b");

        registry.register("plugin", Some("wd_a"), vec![root_str(&dir_a)]);
        registry.register("plugin", Some("wd_b"), vec![root_str(&dir_b)]);

        let catalog = registry.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].description, "plugin b");
    }

    #[test]
    fn plugin_roots_scan_into_the_catalog_as_plugin_source() {
        let mut registry = AgentProfileRegistry::new();
        let plugin_dir = tempfile::tempdir().unwrap();
        write_agent(plugin_dir.path(), "code-reviewer", "Reviews code");
        let extra_dir = tempfile::tempdir().unwrap();
        write_agent(extra_dir.path(), "explorer", "Explores");

        registry.register("plugin", None, vec![root_str(&plugin_dir)]);
        registry.register("extra", None, vec![root_str(&extra_dir)]);

        let catalog = registry.catalog();
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].name, "code-reviewer");
        assert_eq!(catalog[0].source, AgentFileSource::Plugin);
        assert_eq!(catalog[1].name, "explorer");
        assert_eq!(catalog[1].source, AgentFileSource::Extra);
    }

    #[test]
    fn on_changed_fires_for_each_mutation() {
        let mut registry = AgentProfileRegistry::new();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = std::sync::Arc::clone(&seen);
        registry.on_changed(move |change| {
            captured.lock().unwrap().push(change.clone());
        });

        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "alpha", "d");
        registry.register("plugin", None, vec![root_str(&dir)]);
        registry.register("user", Some("wd_a"), vec![root_str(&dir)]);
        registry.unregister("plugin", None);
        // Unregistering a missing entry stays silent.
        registry.unregister("missing", None);

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(
            seen[0],
            AgentProfileRegistryChange {
                source_id: "plugin".into(),
                workspace_key: None,
            }
        );
        assert_eq!(
            seen[1],
            AgentProfileRegistryChange {
                source_id: "user".into(),
                workspace_key: Some("wd_a".into()),
            }
        );
        assert_eq!(
            seen[2],
            AgentProfileRegistryChange {
                source_id: "plugin".into(),
                workspace_key: None,
            }
        );
    }
}
