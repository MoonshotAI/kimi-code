/// Linux ELF injection using objcopy.
///
/// On Linux, the SEA blob is injected as a new ELF section.
/// We use objcopy to add the section, then postject for the sentinel fuse.

#[cfg(target_os = "linux")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::process::Command;
    use std::fs;

    // Copy input to output first
    if input != output {
        fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    // Write blob to a temp file
    let blob_path = format!("{}.blob.tmp", output);
    fs::write(&blob_path, blob_data)
        .map_err(|e| anyhow::anyhow!("Failed to write temp blob: {}", e))?;

    // Add the blob as a new ELF section using objcopy
    let status = Command::new("objcopy")
        .args([
            "--add-section",
            &format!("NODE_SEA_BLOB={}", blob_path),
            output,
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run objcopy: {}", e))?;

    // Clean up temp file
    let _ = fs::remove_file(&blob_path);

    if !status.success() {
        anyhow::bail!("objcopy --add-section failed");
    }

    // Set the sentinel fuse using the postject convention
    // On Linux, the sentinel is written as a note in the ELF
    let status = Command::new("postject")
        .args([
            output,
            "NODE_SEA_BLOB",
            &blob_path,
            "--sentinel-fuse",
            "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to run postject: {}", e))?;

    if !status.success() {
        anyhow::bail!("postject sentinel fuse injection failed");
    }

    println!("  Injected NODE_SEA_BLOB section ({})", blob_data.len());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    anyhow::bail!("ELF injection is only supported on Linux");
}