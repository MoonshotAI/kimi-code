/// macOS Mach-O injection using goblin library.
///
/// On macOS, the SEA blob is injected as a new Mach-O segment/section.
/// After injection, the code signature is invalidated and needs to be
/// removed with codesign.

#[cfg(target_os = "macos")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::process::Command;

    // Copy input to output first
    if input != output {
        std::fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    // Remove existing code signature so the section injection doesn't break it
    let status = Command::new("codesign")
        .args(["--remove-signature", output])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run codesign: {}", e))?;

    if !status.success() {
        anyhow::bail!("codesign --remove-signature failed");
    }

    // Use postject for the actual Mach-O section injection on macOS
    // This is a temporary measure until we implement Mach-O section manipulation
    // in pure Rust. The postject WASM binary handles the complex Mach-O layout.
    let status = Command::new("postject")
        .args([
            output,
            "NODE_SEA_BLOB",
            blob_data,
            "--macho-segment-name",
            "NODE_SEA",
            "--sentinel-fuse",
            "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run postject: {}", e))?;

    if !status.success() {
        anyhow::bail!("postject injection failed");
    }

    println!("  Injected NODE_SEA_BLOB section ({})", blob_data.len());
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    anyhow::bail!("Mach-O injection is only supported on macOS");
}