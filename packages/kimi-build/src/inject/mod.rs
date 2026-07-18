pub mod pe;
#[cfg(target_os = "macos")]
pub mod macho;
#[cfg(target_os = "linux")]
pub mod elf;

use std::path::Path;

/// Run the injection: detect format and dispatch to the platform-specific handler.
pub fn run(input: &str, blob: &str, output: &str) -> anyhow::Result<()> {
    let blob_data = std::fs::read(blob)
        .map_err(|e| anyhow::anyhow!("Failed to read blob file '{}': {}", blob, e))?;

    let input_path = Path::new(input);
    let exe_data = std::fs::read(input_path)
        .map_err(|e| anyhow::anyhow!("Failed to read input executable '{}': {}", input, e))?;

    // Detect format by examining the file header
    if is_pe(&exe_data) {
        pe::inject(input, &blob_data, output)?;
    } else if is_macho(&exe_data) {
        #[cfg(target_os = "macos")]
        {
            macho::inject(input, &blob_data, output)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            anyhow::bail!("Mach-O injection is only supported on macOS");
        }
    } else if is_elf(&exe_data) {
        #[cfg(target_os = "linux")]
        {
            elf::inject(input, &blob_data, output)?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            anyhow::bail!("ELF injection is only supported on Linux");
        }
    } else {
        anyhow::bail!(
            "Unrecognized executable format. Supported: PE (Windows), Mach-O (macOS), ELF (Linux)"
        );
    }

    Ok(())
}

/// Check if the data starts with a PE header (MZ magic).
fn is_pe(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == b'M' && data[1] == b'Z'
}

/// Check if the data starts with a Mach-O header.
fn is_macho(data: &[u8]) -> bool {
    if data.len() < 4 {
        return false;
    }
    // 32-bit: FE ED FA CE, 64-bit: FE ED FA CF
    // Reverse byte order: CE FA ED FE, CF FA ED FE
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    matches!(magic, 0xFEEDFACE | 0xFEEDFACF | 0xCEFAEDFE | 0xCFFAEDFE)
}

/// Check if the data starts with an ELF header.
fn is_elf(data: &[u8]) -> bool {
    data.len() >= 4 && data[0] == 0x7F && data[1] == b'E' && data[2] == b'L' && data[3] == b'F'
}