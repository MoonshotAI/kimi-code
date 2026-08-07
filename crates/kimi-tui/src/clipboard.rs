//! Clipboard image paste (TS `clipboard-image` / `extractMediaAttachments`
//! parity, simplified). Pasting reads a clipboard image into a temp file
//! and inserts a `[image #N]` placeholder into the input; submission
//! expands placeholders into `image_url` content parts the engine's
//! `prompt_parts` accepts. The pure functions are unit-testable; the
//! clipboard read itself shells out to PowerShell on Windows.

use std::path::PathBuf;

/// A pasted image attachment referenced by `[image #N]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    pub id: usize,
    pub path: PathBuf,
    pub mime: String,
}

/// Read the clipboard image, if any (Windows). Returns the temp PNG path
/// and mime, or `None` when the clipboard holds no image.
pub fn clipboard_image() -> anyhow::Result<Option<(PathBuf, String)>> {
    #[cfg(windows)]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$path = Join-Path $env:TEMP ("kimi-paste-" + [guid]::NewGuid().ToString() + ".png")
$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output $path
"#;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()?;
        if !output.status.success() {
            // No image (or a non-image clipboard) — not an error.
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(None);
        }
        Ok(Some((PathBuf::from(path), "image/png".to_string())))
    }
    #[cfg(not(windows))]
    {
        let _ = (); // clipboard image read is Windows-only for now
        Ok(None)
    }
}

/// The `[image #N]` placeholder inserted into the input line.
pub fn placeholder(id: usize) -> String {
    format!("[image #{id}]")
}

/// Expand `[image #N]` placeholders in `text` into prompt content parts:
/// surrounding text as text parts, images as data-URI `image_url` parts
/// (TS `extractMediaAttachments` parity, simplified).
pub fn expand_placeholders(text: &str, attachments: &[ImageAttachment]) -> serde_json::Value {
    use base64::Engine;
    let re = regex::Regex::new(r"\[image #(\d+)\]").expect("valid placeholder regex");
    let mut parts: Vec<serde_json::Value> = Vec::new();
    let mut last = 0usize;
    for cap in re.captures_iter(text) {
        let m = cap.get(0).expect("match");
        let before = &text[last..m.start()];
        if !before.trim().is_empty() {
            parts.push(serde_json::json!({ "type": "text", "text": before }));
        }
        if let Ok(id) = cap[1].parse::<usize>() {
            if let Some(att) = attachments.iter().find(|a| a.id == id) {
                if let Ok(bytes) = std::fs::read(&att.path) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "imageUrl": { "url": format!("data:{};base64,{}", att.mime, b64) }
                    }));
                }
            }
        }
        last = m.end();
    }
    let after = &text[last..];
    if !after.trim().is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": after }));
    }
    if parts.is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": "" }));
    }
    serde_json::json!(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_roundtrips() {
        assert_eq!(placeholder(3), "[image #3]");
    }

    #[test]
    fn expands_placeholders_to_parts() {
        // A tiny PNG so the data URI is non-trivial.
        let dir = std::env::temp_dir().join(format!("kimi-t-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\npayload").unwrap();
        let attachments = vec![ImageAttachment {
            id: 0,
            path: path.clone(),
            mime: "image/png".into(),
        }];

        let parts = expand_placeholders("look: [image #0] done", &attachments);
        let arr = parts.as_array().expect("array");
        assert_eq!(arr.len(), 3, "text + image + text: {parts}");
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "look: ");
        assert_eq!(arr[1]["type"], "image_url");
        let url = arr[1]["imageUrl"]["url"].as_str().expect("url");
        assert!(url.starts_with("data:image/png;base64,"), "url: {url}");
        assert!(!url.contains("\u{0}"), "no NUL in url");
        assert_eq!(arr[2]["text"], " done");

        // Unknown attachment id: placeholder is dropped, text survives.
        let parts = expand_placeholders("[image #99] x", &attachments);
        let arr = parts.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["text"], " x");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_input_yields_single_empty_text_part() {
        let parts = expand_placeholders("", &[]);
        assert_eq!(parts.as_array().unwrap().len(), 1);
        assert_eq!(parts[0]["type"], "text");
    }
}
