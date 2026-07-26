/// KnowledgeService — knowledge base search and storage.
///
/// Corresponds to `packages/agent-core-v2/src/agent/knowledge/`.
/// Delegates actual knowledge operations to the JS host.

use serde::{Deserialize, Serialize};

/// Status of a knowledge entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum KnowledgeStatus {
    #[default]
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "confirmed")]
    Confirmed,
    #[serde(rename = "rejected")]
    Rejected,
}

/// A knowledge entry with rich metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub status: KnowledgeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Input for adding a knowledge entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeAddInput {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Search query for knowledge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeQuery {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f64>,
}

/// Search result with relevance info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeSearchResult {
    pub entries: Vec<KnowledgeEntry>,
    pub total: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relevance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_source: Option<String>,
}

/// Knowledge statistics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeStats {
    pub total_entries: usize,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub by_category: std::collections::HashMap<String, usize>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub by_source: std::collections::HashMap<String, usize>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub by_status: std::collections::HashMap<String, usize>,
    #[serde(default)]
    pub avg_confidence: f64,
}

/// Knowledge service delegate.
pub trait KnowledgeDelegate: Send + Sync {
    fn search(&self, query: &KnowledgeQuery) -> Result<KnowledgeSearchResult, String>;
    fn store(&self, entry: KnowledgeEntry) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
    fn confirm(&self, id: &str) -> Result<(), String> { let _ = id; Ok(()) }
    fn reject(&self, id: &str) -> Result<(), String> { let _ = id; Ok(()) }
    fn stats(&self) -> Result<KnowledgeStats, String> { Ok(KnowledgeStats::default()) }
    fn import_markdown(&self, _content: &str, _category: Option<&str>) -> Result<Vec<KnowledgeEntry>, String> {
        Ok(vec![])
    }
}

/// KnowledgeService — knowledge operations.
pub struct KnowledgeService {
    delegate: Option<Box<dyn KnowledgeDelegate>>,
}

impl KnowledgeService {
    pub fn new() -> Self { Self { delegate: None } }

    pub fn set_delegate(&mut self, delegate: Box<dyn KnowledgeDelegate>) {
        self.delegate = Some(delegate);
    }

    pub fn search(&self, query: &KnowledgeQuery) -> Result<KnowledgeSearchResult, String> {
        match &self.delegate {
            Some(d) => d.search(query),
            None => Ok(KnowledgeSearchResult { entries: vec![], total: 0, relevance: None, match_source: None }),
        }
    }

    pub fn store(&self, entry: KnowledgeEntry) -> Result<(), String> {
        match &self.delegate {
            Some(d) => d.store(entry),
            None => Err("KnowledgeService: no delegate set".into()),
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        match &self.delegate {
            Some(d) => d.delete(id),
            None => Err("KnowledgeService: no delegate set".into()),
        }
    }

    pub fn confirm(&self, id: &str) -> Result<(), String> {
        match &self.delegate {
            Some(d) => d.confirm(id),
            None => Ok(()),
        }
    }

    pub fn reject(&self, id: &str) -> Result<(), String> {
        match &self.delegate {
            Some(d) => d.reject(id),
            None => Ok(()),
        }
    }

    pub fn stats(&self) -> Result<KnowledgeStats, String> {
        match &self.delegate {
            Some(d) => d.stats(),
            None => Ok(KnowledgeStats::default()),
        }
    }

    pub fn import_markdown(&self, content: &str, category: Option<&str>) -> Result<Vec<KnowledgeEntry>, String> {
        match &self.delegate {
            Some(d) => d.import_markdown(content, category),
            None => {
                // No delegate: just parse and return without storing.
                Ok(parse_markdown_knowledge(content, category))
            }
        }
    }

    /// Auto-categorize a knowledge entry based on its content and title.
    ///
    /// Uses simple keyword matching. For more accurate categorization, the
    /// delegate can override this method.
    pub fn categorize(&self, entry: &KnowledgeEntry) -> String {
        if let Some(ref category) = entry.category {
            if !category.is_empty() {
                return category.clone();
            }
        }
        auto_categorize(&entry.content, entry.title.as_deref())
    }

    /// Calculate a confidence score for a knowledge entry.
    ///
    /// Based on source type, status, and content length. The delegate can
    /// override this for more sophisticated scoring.
    pub fn calculate_confidence(&self, entry: &KnowledgeEntry) -> f64 {
        let mut score = 0.5; // base

        // Source factor
        match entry.source.as_deref() {
            Some("human") => score += 0.3,
            Some("ai-confirmed") => score += 0.2,
            Some("ai-learned") => score += 0.0,
            _ => score += 0.1,
        }

        // Status factor
        match entry.status {
            KnowledgeStatus::Confirmed => score += 0.2,
            KnowledgeStatus::Pending => score -= 0.1,
            KnowledgeStatus::Rejected => score -= 0.5,
        }

        // Content length factor (longer content = more likely to be meaningful)
        let content_len = entry.content.len();
        if content_len > 500 {
            score += 0.1;
        } else if content_len < 20 {
            score -= 0.1;
        }

        // Tags factor
        if !entry.tags.is_empty() {
            score += 0.05 * entry.tags.len().min(4) as f64;
        }

        score.clamp(0.0, 1.0)
    }
}

impl Default for KnowledgeService { fn default() -> Self { Self::new() } }

// ── Helper functions ─────────────────────────────────────────────────────────

/// Auto-categorize content based on keyword matching.
fn auto_categorize(content: &str, title: Option<&str>) -> String {
    let combined = match title {
        Some(t) => format!("{} {}", t, content),
        None => content.to_string(),
    };
    let lower = combined.to_lowercase();

    let categories: Vec<(&str, &[&str])> = vec![
        ("coding-style", &["style", "format", "lint", "naming", "convention", "indent", "eslint", "prettier"]),
        ("pitfall", &["pitfall", "gotcha", "bug", "anti-pattern", "warning", "avoid", "danger", "common mistake", "incorrect", "wrong"]),
        ("architecture", &["architecture", "design", "pattern", "module", "component", "structure", "dependency", "diagram", "overview"]),
        ("workflow", &["workflow", "ci/cd", "deploy", "build", "test", "release", "pipeline", "git", "command"]),
    ];

    for (category, keywords) in &categories {
        for kw in *keywords {
            if lower.contains(kw) {
                return category.to_string();
            }
        }
    }

    "coding-style".to_string() // default
}

/// Parse markdown content into knowledge entries.
/// Each top-level heading (`# Title`) starts a new entry.
fn parse_markdown_knowledge(content: &str, default_category: Option<&str>) -> Vec<KnowledgeEntry> {
    let mut entries = Vec::new();
    let mut current_title = String::new();
    let mut current_body = Vec::new();
    let category = default_category.unwrap_or("coding-style");

    for line in content.lines() {
        if line.starts_with("# ") {
            // Flush previous entry
            if !current_title.is_empty() || !current_body.is_empty() {
                entries.push(build_entry(&current_title, &current_body.join("\n"), category));
            }
            current_title = line.trim_start_matches("# ").to_string();
            current_body.clear();
        } else {
            current_body.push(line);
        }
    }

    // Flush last entry
    if !current_title.is_empty() || !current_body.is_empty() {
        entries.push(build_entry(&current_title, &current_body.join("\n"), category));
    }

    // If no headings found, treat the whole content as a single entry
    if entries.is_empty() && !content.trim().is_empty() {
        entries.push(build_entry("", content, category));
    }

    entries
}

fn build_entry(title: &str, body: &str, category: &str) -> KnowledgeEntry {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("k-{:016x}", now);

    let content = if title.is_empty() {
        body.trim().to_string()
    } else {
        format!("{}: {}", title, body.trim())
    };

    KnowledgeEntry {
        id,
        content,
        category: Some(category.to_string()),
        title: Some(title.to_string()),
        tags: vec![],
        scope: None,
        confidence: Some(0.8),
        source: Some("ai-learned".to_string()),
        status: KnowledgeStatus::Pending,
        metadata: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_search_empty() {
        let ks = KnowledgeService::new();
        let r = ks.search(&KnowledgeQuery { text: "test".into(), max_results: None, category: None, scope: None, min_confidence: None }).unwrap();
        assert!(r.entries.is_empty());
    }

    #[test]
    fn test_store_no_delegate_fails() {
        let ks = KnowledgeService::new();
        let e = KnowledgeEntry { id: "1".into(), content: "x".into(), category: None, title: None, tags: vec![], scope: None, confidence: None, source: None, status: KnowledgeStatus::Pending, metadata: None };
        assert!(ks.store(e).is_err());
    }

    #[test]
    fn test_with_delegate() {
        let mut ks = KnowledgeService::new();
        struct D;
        impl KnowledgeDelegate for D {
            fn search(&self, _q: &KnowledgeQuery) -> Result<KnowledgeSearchResult, String> {
                Ok(KnowledgeSearchResult { entries: vec![KnowledgeEntry { id: "1".into(), content: "found".into(), category: None, title: None, tags: vec![], scope: None, confidence: None, source: None, status: KnowledgeStatus::Confirmed, metadata: None }], total: 1, relevance: None, match_source: None })
            }
            fn store(&self, _e: KnowledgeEntry) -> Result<(), String> { Ok(()) }
            fn delete(&self, _id: &str) -> Result<(), String> { Ok(()) }
        }
        ks.set_delegate(Box::new(D));
        let r = ks.search(&KnowledgeQuery { text: "find".into(), max_results: Some(5), category: None, scope: None, min_confidence: None }).unwrap();
        assert_eq!(r.total, 1);
    }

    #[test]
    fn test_confirm_reject() {
        let mut ks = KnowledgeService::new();
        struct D;
        impl KnowledgeDelegate for D {
            fn search(&self, _q: &KnowledgeQuery) -> Result<KnowledgeSearchResult, String> { Ok(KnowledgeSearchResult { entries: vec![], total: 0, relevance: None, match_source: None }) }
            fn store(&self, _e: KnowledgeEntry) -> Result<(), String> { Ok(()) }
            fn delete(&self, _id: &str) -> Result<(), String> { Ok(()) }
        }
        ks.set_delegate(Box::new(D));
        assert!(ks.confirm("test-id").is_ok());
        assert!(ks.reject("test-id").is_ok());
    }

    #[test]
    fn test_stats_default() {
        let ks = KnowledgeService::new();
        let s = ks.stats().unwrap();
        assert_eq!(s.total_entries, 0);
    }

    #[test]
    fn test_categorize_architecture() {
        let entry = KnowledgeEntry {
            id: "1".into(), content: "The system uses a microservices architecture with event-driven communication.".into(),
            category: None, title: None, tags: vec![], scope: None, confidence: None,
            source: None, status: KnowledgeStatus::Pending, metadata: None,
        };
        let ks = KnowledgeService::new();
        let cat = ks.categorize(&entry);
        assert_eq!(cat, "architecture");
    }

    #[test]
    fn test_categorize_workflow() {
        let entry = KnowledgeEntry {
            id: "2".into(), content: "Run `npm run build` to build the project. CI pipeline runs on every PR.".into(),
            category: None, title: None, tags: vec![], scope: None, confidence: None,
            source: None, status: KnowledgeStatus::Pending, metadata: None,
        };
        let ks = KnowledgeService::new();
        let cat = ks.categorize(&entry);
        assert_eq!(cat, "workflow");
    }

    #[test]
    fn test_categorize_coding_style() {
        let entry = KnowledgeEntry {
            id: "3".into(), content: "Use camelCase for variable names.".into(),
            category: None, title: None, tags: vec![], scope: None, confidence: None,
            source: None, status: KnowledgeStatus::Pending, metadata: None,
        };
        let ks = KnowledgeService::new();
        let cat = ks.categorize(&entry);
        assert_eq!(cat, "coding-style");
    }

    #[test]
    fn test_categorize_pitfall() {
        let entry = KnowledgeEntry {
            id: "4".into(), content: "Common pitfall: forgetting to handle the error case.".into(),
            category: None, title: None, tags: vec![], scope: None, confidence: None,
            source: None, status: KnowledgeStatus::Pending, metadata: None,
        };
        let ks = KnowledgeService::new();
        let cat = ks.categorize(&entry);
        assert_eq!(cat, "pitfall");
    }

    #[test]
    fn test_categorize_explicit_overrides() {
        let entry = KnowledgeEntry {
            id: "5".into(), content: "some content".into(),
            category: Some("architecture".into()), title: None, tags: vec![], scope: None,
            confidence: None, source: None, status: KnowledgeStatus::Pending, metadata: None,
        };
        let ks = KnowledgeService::new();
        let cat = ks.categorize(&entry);
        assert_eq!(cat, "architecture");
    }

    #[test]
    fn test_calculate_confidence_human() {
        let entry = KnowledgeEntry {
            id: "1".into(), content: "A".repeat(600).into(),
            category: None, title: None, tags: vec!["important".into()], scope: None,
            confidence: None, source: Some("human".into()), status: KnowledgeStatus::Confirmed, metadata: None,
        };
        let ks = KnowledgeService::new();
        let conf = ks.calculate_confidence(&entry);
        assert!(conf > 0.8);
    }

    #[test]
    fn test_calculate_confidence_rejected() {
        let entry = KnowledgeEntry {
            id: "2".into(), content: "short".into(),
            category: None, title: None, tags: vec![], scope: None,
            confidence: None, source: Some("ai-learned".into()), status: KnowledgeStatus::Rejected, metadata: None,
        };
        let ks = KnowledgeService::new();
        let conf = ks.calculate_confidence(&entry);
        assert!(conf < 0.3);
    }

    #[test]
    fn test_import_markdown_no_delegate() {
        let ks = KnowledgeService::new();
        let md = "# Title 1\nContent 1\n\n# Title 2\nContent 2\n";
        let entries = ks.import_markdown(md, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].title.as_deref() == Some("Title 1"));
        assert!(entries[1].title.as_deref() == Some("Title 2"));
    }

    #[test]
    fn test_import_markdown_single_entry() {
        let ks = KnowledgeService::new();
        let md = "Just some plain content without headings.";
        let entries = ks.import_markdown(md, Some("workflow")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].category.as_deref(), Some("workflow"));
    }

    #[test]
    fn test_auto_categorize_default() {
        let cat = auto_categorize("some random content that doesn't match any keywords", None);
        assert_eq!(cat, "coding-style");
    }
}