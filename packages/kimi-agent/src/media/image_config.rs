/// Image configuration bridge — read image processing strategy from config.
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/imageConfigBridge.ts`
/// and `configSection.ts`.
///
/// Provides:
/// - Image strategy configuration (max edge, byte budget, etc.)
/// - Responsive config updates via a listener pattern
/// - Default values when config is not present
///
/// The bridge reads image configuration from the application configuration
/// (TOML-based) and exposes it through a typed API.

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::{Arc, RwLock};

// ---------------------------------------------------------------------------
// Constants (defaults, mirroring the values in mod.rs)
// ---------------------------------------------------------------------------

/// Default maximum image edge in pixels.
pub const DEFAULT_MAX_IMAGE_EDGE_PX: u32 = 2000;

/// Default per-image byte budget (~3.75 MiB).
pub const DEFAULT_IMAGE_BYTE_BUDGET: usize = 3_750_000;

/// Default maximum decode pixels (100 MP).
pub const DEFAULT_MAX_DECODE_PIXELS: u64 = 100_000_000;

/// Default maximum image decode bytes (64 MB).
pub const DEFAULT_MAX_IMAGE_DECODE_BYTES: usize = 64 * 1024 * 1024;

/// Default JPEG quality for compression.
pub const DEFAULT_JPEG_QUALITY: u8 = 85;

/// Env var overriding the default max image edge in pixels.
///
/// Mirrors `MAX_IMAGE_EDGE_ENV` in the TS `image-compress.ts` module.
pub const MAX_IMAGE_EDGE_ENV: &str = "KIMI_IMAGE_MAX_EDGE_PX";

/// Env var overriding the default image byte budget.
///
/// Mirrors `READ_IMAGE_BYTE_BUDGET_ENV` in the TS `image-compress.ts` module.
pub const READ_IMAGE_BYTE_BUDGET_ENV: &str = "KIMI_IMAGE_READ_BYTE_BUDGET";

// ---------------------------------------------------------------------------
// Strategy enum
// ---------------------------------------------------------------------------

/// Image processing strategy: how images should be handled before being sent
/// to the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageStrategy {
    /// Auto-detect: compress if needed, otherwise pass through.
    #[serde(rename = "auto")]
    Auto,
    /// Always compress images to fit within the budget.
    #[serde(rename = "compress")]
    Compress,
    /// Always pass images through at their original resolution.
    #[serde(rename = "passthrough")]
    Passthrough,
    /// Skip image processing entirely (images are omitted).
    #[serde(rename = "skip")]
    Skip,
}

impl Default for ImageStrategy {
    fn default() -> Self {
        Self::Auto
    }
}

// ---------------------------------------------------------------------------
// ImageConfig struct
// ---------------------------------------------------------------------------

/// Image processing configuration.
///
/// Mirrors the TS `ImageConfig` type in `imageConfigBridge.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageConfig {
    /// Image processing strategy.
    #[serde(default)]
    pub strategy: ImageStrategy,

    /// Maximum image edge length in pixels (longest side).
    /// Images exceeding this will be downscaled.
    #[serde(default = "default_max_edge_px")]
    pub max_edge_px: u32,

    /// Per-image byte budget for the model.
    #[serde(default = "default_byte_budget")]
    pub byte_budget: usize,

    /// Maximum pixel count for decode (safety limit).
    #[serde(default = "default_max_decode_pixels")]
    pub max_decode_pixels: u64,

    /// Maximum decode bytes (safety limit).
    #[serde(default = "default_max_decode_bytes")]
    pub max_decode_bytes: usize,

    /// JPEG quality for compressed images (1-100).
    #[serde(default = "default_jpeg_quality")]
    pub jpeg_quality: u8,

    /// Whether to annotate compression in the message.
    #[serde(default)]
    pub annotate_compression: bool,

    /// Whether to enable full-resolution mode by default.
    #[serde(default)]
    pub full_resolution: bool,
}

fn default_max_edge_px() -> u32 {
    DEFAULT_MAX_IMAGE_EDGE_PX
}
fn default_byte_budget() -> usize {
    DEFAULT_IMAGE_BYTE_BUDGET
}
fn default_max_decode_pixels() -> u64 {
    DEFAULT_MAX_DECODE_PIXELS
}
fn default_max_decode_bytes() -> usize {
    DEFAULT_MAX_IMAGE_DECODE_BYTES
}
fn default_jpeg_quality() -> u8 {
    DEFAULT_JPEG_QUALITY
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            strategy: ImageStrategy::Auto,
            max_edge_px: DEFAULT_MAX_IMAGE_EDGE_PX,
            byte_budget: DEFAULT_IMAGE_BYTE_BUDGET,
            max_decode_pixels: DEFAULT_MAX_DECODE_PIXELS,
            max_decode_bytes: DEFAULT_MAX_IMAGE_DECODE_BYTES,
            jpeg_quality: DEFAULT_JPEG_QUALITY,
            annotate_compression: false,
            full_resolution: false,
        }
    }
}

impl ImageConfig {
    /// Create a new `ImageConfig` with all default values.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a config from built-in defaults overridden by the `KIMI_IMAGE_*`
    /// env vars, mirroring the TS `ImageLimits` env resolution
    /// (`image-limits.ts`): `KIMI_IMAGE_MAX_EDGE_PX` overrides `max_edge_px`
    /// and `KIMI_IMAGE_READ_BYTE_BUDGET` overrides `byte_budget`. Unset or
    /// invalid values are ignored and the built-in default is kept.
    pub fn from_env() -> Self {
        Self::from_env_with(|name| std::env::var(name).ok())
    }

    /// Like [`Self::from_env`], but with an injected env lookup (testable).
    pub fn from_env_with(env: impl Fn(&str) -> Option<String>) -> Self {
        let mut config = Self::default();
        if let Some(px) = positive_int_from_env::<u32>(&env, MAX_IMAGE_EDGE_ENV) {
            config.max_edge_px = px;
        }
        if let Some(budget) = positive_int_from_env::<usize>(&env, READ_IMAGE_BYTE_BUDGET_ENV) {
            config.byte_budget = budget;
        }
        config
    }

    /// Merge another `ImageConfig` into this one, taking non-default values.
    ///
    /// Fields with `None` in the overlay are skipped (the receiver's value is kept).
    /// This is used for layered config merging (e.g. global defaults + project overrides).
    pub fn merge(&mut self, overlay: &ImageConfigOverlay) {
        if let Some(strategy) = overlay.strategy {
            self.strategy = strategy;
        }
        if let Some(max_edge_px) = overlay.max_edge_px {
            self.max_edge_px = max_edge_px;
        }
        if let Some(byte_budget) = overlay.byte_budget {
            self.byte_budget = byte_budget;
        }
        if let Some(max_decode_pixels) = overlay.max_decode_pixels {
            self.max_decode_pixels = max_decode_pixels;
        }
        if let Some(max_decode_bytes) = overlay.max_decode_bytes {
            self.max_decode_bytes = max_decode_bytes;
        }
        if let Some(jpeg_quality) = overlay.jpeg_quality {
            self.jpeg_quality = jpeg_quality;
        }
        if let Some(annotate) = overlay.annotate_compression {
            self.annotate_compression = annotate;
        }
        if let Some(full_res) = overlay.full_resolution {
            self.full_resolution = full_res;
        }
    }
}

/// Parse a positive-integer env var, mirroring the TS `positiveIntFromEnv`
/// semantics (`image-compress.ts`): unset, empty, non-digit, zero, or
/// out-of-range values are ignored (`None`). Values are trimmed before
/// validation.
fn positive_int_from_env<T>(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<T>
where
    T: FromStr + PartialOrd + From<u8>,
{
    let raw = env(name)?;
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed: T = raw.parse().ok()?;
    (parsed > T::from(0u8)).then_some(parsed)
}

/// Partial overlay for merging into an `ImageConfig`.
///
/// All fields are `Option`al — only present fields are applied during merge.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImageConfigOverlay {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<ImageStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_edge_px: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_budget: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_decode_pixels: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_decode_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotate_compression: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_resolution: Option<bool>,
}

// ---------------------------------------------------------------------------
// Config bridge (thread-safe, observable)
// ---------------------------------------------------------------------------

/// Callback type for config change notifications.
type ConfigChangeCallback = Arc<dyn Fn(&ImageConfig) + Send + Sync>;

/// Thread-safe image configuration bridge.
///
/// Holds the current `ImageConfig` and notifies listeners on changes.
/// Used to bridge between the application config system and the image
/// processing pipeline.
#[derive(Clone)]
pub struct ImageConfigBridge {
    inner: Arc<RwLock<BridgeInner>>,
}

struct BridgeInner {
    config: ImageConfig,
    listeners: Vec<ConfigChangeCallback>,
}

impl ImageConfigBridge {
    /// Create a new bridge with the given initial config.
    pub fn new(config: ImageConfig) -> Self {
        Self {
            inner: Arc::new(RwLock::new(BridgeInner {
                config,
                listeners: Vec::new(),
            })),
        }
    }

    /// Create a bridge with default config values.
    ///
    /// `KIMI_IMAGE_*` env overrides are applied on top of the built-in
    /// defaults (see [`ImageConfig::from_env`]).
    pub fn default_config() -> Self {
        Self::new(ImageConfig::from_env())
    }

    /// Get the current image configuration.
    pub fn get_config(&self) -> ImageConfig {
        self.inner.read().unwrap().config.clone()
    }

    /// Update the configuration and notify all listeners.
    ///
    /// # Arguments
    ///
    /// * `new_config` - The new configuration to apply
    pub fn update_config(&self, new_config: ImageConfig) {
        let mut inner = self.inner.write().unwrap();
        inner.config = new_config.clone();
        let listeners = inner.listeners.clone();
        drop(inner);

        // Notify listeners outside the write lock
        for listener in &listeners {
            listener(&new_config);
        }
    }

    /// Merge an overlay into the current configuration.
    ///
    /// # Arguments
    ///
    /// * `overlay` - Partial config to merge
    pub fn merge_config(&self, overlay: &ImageConfigOverlay) {
        let mut inner = self.inner.write().unwrap();
        inner.config.merge(overlay);
        let new_config = inner.config.clone();
        let listeners = inner.listeners.clone();
        drop(inner);

        for listener in &listeners {
            listener(&new_config);
        }
    }

    /// Register a listener for config changes.
    ///
    /// The listener will be called with the new config whenever `update_config`
    /// or `merge_config` is called.
    ///
    /// # Arguments
    ///
    /// * `callback` - The callback to invoke on config changes
    pub fn on_change(&self, callback: ConfigChangeCallback) {
        let mut inner = self.inner.write().unwrap();
        inner.listeners.push(callback);
    }

    /// Convenience: get the current max edge in pixels.
    pub fn max_edge_px(&self) -> u32 {
        self.get_config().max_edge_px
    }

    /// Convenience: get the current byte budget.
    pub fn byte_budget(&self) -> usize {
        self.get_config().byte_budget
    }

    /// Convenience: get the current JPEG quality.
    pub fn jpeg_quality(&self) -> u8 {
        self.get_config().jpeg_quality
    }

    /// Convenience: get the current strategy.
    pub fn strategy(&self) -> ImageStrategy {
        self.get_config().strategy
    }

    /// Check if the image should be skipped entirely.
    pub fn should_skip(&self) -> bool {
        self.get_config().strategy == ImageStrategy::Skip
    }

    /// Check if the image should always be passed through.
    pub fn should_passthrough(&self) -> bool {
        self.get_config().strategy == ImageStrategy::Passthrough
    }

    /// Check if the image should be compressed.
    pub fn should_compress(&self) -> bool {
        self.get_config().strategy == ImageStrategy::Compress
            || self.get_config().strategy == ImageStrategy::Auto
    }
}

// ---------------------------------------------------------------------------
// TOML config section
// ---------------------------------------------------------------------------

/// The `[media.image]` config section in TOML.
///
/// This is the deserialization target for the image configuration section
/// in the application's TOML config file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImageConfigSection {
    /// Image processing strategy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,

    /// Maximum image edge in pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_edge_px: Option<u32>,

    /// Per-image byte budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_budget: Option<usize>,

    /// Maximum decode pixels (safety limit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_decode_pixels: Option<u64>,

    /// Maximum decode bytes (safety limit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_decode_bytes: Option<usize>,

    /// JPEG quality (1-100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u8>,

    /// Whether to annotate compression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotate_compression: Option<bool>,

    /// Whether to use full resolution by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_resolution: Option<bool>,
}

impl ImageConfigSection {
    /// Convert this section to an `ImageConfigOverlay`.
    ///
    /// Parses the `strategy` string field into the `ImageStrategy` enum.
    /// Returns `None` if the strategy string is present but invalid.
    pub fn to_overlay(&self) -> ImageConfigOverlay {
        let strategy = self.strategy.as_ref().and_then(|s| match s.as_str() {
            "auto" => Some(ImageStrategy::Auto),
            "compress" => Some(ImageStrategy::Compress),
            "passthrough" => Some(ImageStrategy::Passthrough),
            "skip" => Some(ImageStrategy::Skip),
            _ => None,
        });

        ImageConfigOverlay {
            strategy,
            max_edge_px: self.max_edge_px,
            byte_budget: self.byte_budget,
            max_decode_pixels: self.max_decode_pixels,
            max_decode_bytes: self.max_decode_bytes,
            jpeg_quality: self.jpeg_quality,
            annotate_compression: self.annotate_compression,
            full_resolution: self.full_resolution,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ImageConfig::default();
        assert_eq!(config.strategy, ImageStrategy::Auto);
        assert_eq!(config.max_edge_px, 2000);
        assert_eq!(config.byte_budget, 3_750_000);
        assert_eq!(config.jpeg_quality, 85);
        assert!(!config.annotate_compression);
        assert!(!config.full_resolution);
    }

    #[test]
    fn test_config_merge() {
        let mut config = ImageConfig::default();
        let overlay = ImageConfigOverlay {
            strategy: Some(ImageStrategy::Compress),
            max_edge_px: Some(1024),
            byte_budget: None,
            max_decode_pixels: None,
            max_decode_bytes: None,
            jpeg_quality: None,
            annotate_compression: None,
            full_resolution: None,
        };
        config.merge(&overlay);
        assert_eq!(config.strategy, ImageStrategy::Compress);
        assert_eq!(config.max_edge_px, 1024);
        // Unchanged fields keep their defaults
        assert_eq!(config.byte_budget, DEFAULT_IMAGE_BYTE_BUDGET);
    }

    #[test]
    fn test_bridge_get_set() {
        let bridge = ImageConfigBridge::default_config();
        assert_eq!(bridge.strategy(), ImageStrategy::Auto);
        assert_eq!(bridge.max_edge_px(), 2000);
        assert_eq!(bridge.byte_budget(), 3_750_000);
        assert!(!bridge.should_skip());
        assert!(!bridge.should_passthrough());
        assert!(bridge.should_compress());

        // Update config
        let mut new_config = ImageConfig::default();
        new_config.strategy = ImageStrategy::Passthrough;
        new_config.max_edge_px = 1024;
        bridge.update_config(new_config);

        assert_eq!(bridge.strategy(), ImageStrategy::Passthrough);
        assert_eq!(bridge.max_edge_px(), 1024);
        assert!(bridge.should_passthrough());
        assert!(!bridge.should_compress());
    }

    #[test]
    fn test_bridge_merge() {
        let bridge = ImageConfigBridge::default_config();
        let overlay = ImageConfigOverlay {
            strategy: Some(ImageStrategy::Skip),
            max_edge_px: None,
            byte_budget: None,
            max_decode_pixels: None,
            max_decode_bytes: None,
            jpeg_quality: None,
            annotate_compression: None,
            full_resolution: None,
        };
        bridge.merge_config(&overlay);
        assert!(bridge.should_skip());
        // Other fields unchanged
        assert_eq!(bridge.max_edge_px(), 2000);
    }

    #[test]
    fn test_bridge_on_change() {
        let bridge = ImageConfigBridge::default_config();
        let changed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed_clone = changed.clone();

        bridge.on_change(Arc::new(move |_| {
            changed_clone.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        let mut new_config = ImageConfig::default();
        new_config.max_edge_px = 512;
        bridge.update_config(new_config);

        assert!(changed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn test_config_section_to_overlay() {
        let section = ImageConfigSection {
            strategy: Some("compress".to_string()),
            max_edge_px: Some(1024),
            byte_budget: Some(2_000_000),
            max_decode_pixels: None,
            max_decode_bytes: None,
            jpeg_quality: Some(80),
            annotate_compression: Some(true),
            full_resolution: None,
        };

        let overlay = section.to_overlay();
        assert_eq!(overlay.strategy, Some(ImageStrategy::Compress));
        assert_eq!(overlay.max_edge_px, Some(1024));
        assert_eq!(overlay.byte_budget, Some(2_000_000));
        assert_eq!(overlay.jpeg_quality, Some(80));
        assert_eq!(overlay.annotate_compression, Some(true));
        assert!(overlay.max_decode_pixels.is_none());
        assert!(overlay.full_resolution.is_none());
    }

    #[test]
    fn test_config_section_invalid_strategy() {
        let section = ImageConfigSection {
            strategy: Some("invalid".to_string()),
            ..Default::default()
        };
        let overlay = section.to_overlay();
        assert!(overlay.strategy.is_none());
    }

    #[test]
    fn test_skip_and_passthrough_checks() {
        let skip_config = ImageConfig {
            strategy: ImageStrategy::Skip,
            ..ImageConfig::default()
        };
        assert!(ImageConfigBridge::new(skip_config).should_skip());

        let passthrough_config = ImageConfig {
            strategy: ImageStrategy::Passthrough,
            ..ImageConfig::default()
        };
        assert!(ImageConfigBridge::new(passthrough_config).should_passthrough());

        let auto_config = ImageConfig {
            strategy: ImageStrategy::Auto,
            ..ImageConfig::default()
        };
        assert!(!ImageConfigBridge::new(auto_config).should_skip());
        assert!(!ImageConfigBridge::new(ImageConfig {
            strategy: ImageStrategy::Auto,
            ..ImageConfig::default()
        }).should_passthrough());
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = ImageConfig {
            strategy: ImageStrategy::Compress,
            max_edge_px: 1024,
            byte_budget: 2_000_000,
            max_decode_pixels: 50_000_000,
            max_decode_bytes: 32_000_000,
            jpeg_quality: 75,
            annotate_compression: true,
            full_resolution: false,
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ImageConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.strategy, ImageStrategy::Compress);
        assert_eq!(deserialized.max_edge_px, 1024);
        assert_eq!(deserialized.byte_budget, 2_000_000);
        assert_eq!(deserialized.jpeg_quality, 75);
    }

    #[test]
    fn test_toml_roundtrip() {
        let section = ImageConfigSection {
            strategy: Some("auto".to_string()),
            max_edge_px: Some(2000),
            byte_budget: Some(3_750_000),
            max_decode_pixels: None,
            max_decode_bytes: None,
            jpeg_quality: None,
            annotate_compression: None,
            full_resolution: None,
        };

        let toml_str = toml::to_string(&section).unwrap();
        let deserialized: ImageConfigSection = toml::from_str(&toml_str).unwrap();
        assert_eq!(deserialized.strategy, Some("auto".to_string()));
        assert_eq!(deserialized.max_edge_px, Some(2000));
        assert_eq!(deserialized.byte_budget, Some(3_750_000));
    }

    /// Env lookup returning the given overrides; everything else is unset.
    fn env_with<'a>(overrides: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let map: std::collections::HashMap<&str, &str> = overrides.iter().copied().collect();
        move |name| map.get(name).map(|v| v.to_string())
    }

    #[test]
    fn test_from_env_applies_valid_overrides() {
        let config = ImageConfig::from_env_with(env_with(&[
            (MAX_IMAGE_EDGE_ENV, "1024"),
            (READ_IMAGE_BYTE_BUDGET_ENV, "512000"),
        ]));
        assert_eq!(config.max_edge_px, 1024);
        assert_eq!(config.byte_budget, 512_000);
        // Fields without an env override keep their defaults.
        assert_eq!(config.strategy, ImageStrategy::Auto);
        assert_eq!(config.max_decode_pixels, DEFAULT_MAX_DECODE_PIXELS);
        assert_eq!(config.jpeg_quality, DEFAULT_JPEG_QUALITY);
    }

    #[test]
    fn test_from_env_unset_returns_defaults() {
        assert_eq!(ImageConfig::from_env_with(|_| None), ImageConfig::default());
        assert_eq!(
            ImageConfig::from_env_with(env_with(&[])),
            ImageConfig::default()
        );
    }

    #[test]
    fn test_from_env_invalid_values_fall_back_to_default() {
        // Non-numeric, zero, negative, empty, and out-of-range values are
        // ignored, matching the TS `positiveIntFromEnv` semantics.
        let invalid = ["abc", "0", "-1", "", "+512", "1_000", "99999999999999999999"];
        for max_edge in invalid {
            let config = ImageConfig::from_env_with(env_with(&[(MAX_IMAGE_EDGE_ENV, max_edge)]));
            assert_eq!(config, ImageConfig::default(), "max_edge={max_edge:?}");
        }
        for budget in invalid {
            let config = ImageConfig::from_env_with(env_with(&[(READ_IMAGE_BYTE_BUDGET_ENV, budget)]));
            assert_eq!(config, ImageConfig::default(), "budget={budget:?}");
        }
    }

    #[test]
    fn test_from_env_overrides_are_independent() {
        // Each variable is parsed independently: an invalid value falls back
        // without affecting a valid sibling.
        let config = ImageConfig::from_env_with(env_with(&[
            (MAX_IMAGE_EDGE_ENV, "bad"),
            (READ_IMAGE_BYTE_BUDGET_ENV, "512000"),
        ]));
        assert_eq!(config.max_edge_px, DEFAULT_MAX_IMAGE_EDGE_PX);
        assert_eq!(config.byte_budget, 512_000);
    }

    #[test]
    fn test_from_env_trims_whitespace() {
        let config = ImageConfig::from_env_with(env_with(&[
            (MAX_IMAGE_EDGE_ENV, " 1024 "),
            (READ_IMAGE_BYTE_BUDGET_ENV, "512000"),
        ]));
        assert_eq!(config.max_edge_px, 1024);
        assert_eq!(config.byte_budget, 512_000);
    }
}