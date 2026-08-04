//! Model catalog — fetch the provider/model directory from models.dev
//! (`https://models.dev/api.json`), mirroring node-sdk's `catalog.ts`.
//! Transport via reqwest (rustls), which avoids the Windows schannel
//! certificate-revocation check that blocks plain curl on some networks.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The default catalog URL (models.dev provider directory).
pub const DEFAULT_CATALOG_URL: &str = "https://models.dev/api.json";

/// A provider entry from the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogProvider {
    pub id: String,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub npm: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub doc: Option<String>,
    #[serde(default)]
    pub models: HashMap<String, CatalogModel>,
}

/// A single model inside a provider entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub context_length: Option<u64>,
    #[serde(default)]
    pub cost: Option<CatalogCost>,
}

/// Pricing info for a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCost {
    #[serde(default)]
    pub input: Option<f64>,
    #[serde(default)]
    pub output: Option<f64>,
}

/// Fetch and parse the model catalog.
pub async fn fetch_catalog(url: &str) -> anyhow::Result<HashMap<String, CatalogProvider>> {
    let body = reqwest::get(url).await?.error_for_status()?;
    let catalog: HashMap<String, CatalogProvider> = body.json().await?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_provider_fixture() {
        let json = r#"{
            "acme": {
                "id": "acme",
                "env": ["ACME_API_KEY"],
                "api": "https://acme.example/v1",
                "name": "Acme",
                "models": {
                    "acme-1": {
                        "id": "acme-1",
                        "name": "Acme 1",
                        "reasoning": true,
                        "context_length": 128000,
                        "cost": { "input": 0.5, "output": 1.5 }
                    }
                }
            }
        }"#;
        let catalog: HashMap<String, CatalogProvider> = serde_json::from_str(json).unwrap();
        let provider = &catalog["acme"];
        assert_eq!(provider.name, "Acme");
        assert_eq!(provider.env, vec!["ACME_API_KEY"]);
        let model = &provider.models["acme-1"];
        assert_eq!(model.id, "acme-1");
        assert_eq!(model.reasoning, Some(true));
        assert_eq!(model.context_length, Some(128000));
        assert_eq!(model.cost.as_ref().unwrap().input, Some(0.5));
    }

    #[tokio::test]
    async fn fetch_live_catalog() {
        // Network-dependent: the model directory must be reachable. Skipped
        // when the fetch fails (offline CI / revocation-blocked networks).
        match fetch_catalog(DEFAULT_CATALOG_URL).await {
            Ok(catalog) => {
                assert!(catalog.len() >= 50, "catalog has providers: {}", catalog.len());
                assert!(
                    catalog.values().any(|p| !p.models.is_empty()),
                    "at least one provider lists models"
                );
            }
            Err(e) => eprintln!("skipping live catalog test (network): {e}"),
        }
    }
}
