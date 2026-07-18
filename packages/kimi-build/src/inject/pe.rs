/// Windows PE injection using Windows UpdateResource API.
///
/// On Windows, the SEA blob is stored as a custom PE resource (RT_RCDATA)
/// named "NODE_SEA_BLOB". We use the standard Windows API to add/replace
/// this resource in the executable.

#[cfg(target_os = "windows")]
pub fn inject(input: &str, blob_data: &[u8], output: &str) -> anyhow::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::shared::minwindef::FALSE;
    use winapi::shared::minwindef::TRUE;
    use winapi::um::winbase::BeginUpdateResourceW;
    use winapi::um::winbase::EndUpdateResourceW;
    use winapi::um::winbase::UpdateResourceW;
    use winapi::um::winnt::MAKELANGID;
    use winapi::um::winnt::LANG_NEUTRAL;
    use winapi::um::winnt::SUBLANG_NEUTRAL;
    use winapi::um::winuser::RT_RCDATA;

    // Copy input to output first
    if input != output {
        std::fs::copy(input, output)
            .map_err(|e| anyhow::anyhow!("Failed to copy '{}' to '{}': {}", input, output, e))?;
    }

    // Convert path to wide string
    let output_wide: Vec<u16> = OsStr::new(output)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // Open the executable for resource update
    let handle = unsafe { BeginUpdateResourceW(output_wide.as_ptr(), FALSE) };
    if handle.is_null() {
        anyhow::bail!(
            "BeginUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    // Write the SEA blob as RT_RCDATA resource named "NODE_SEA_BLOB"
    let name_wide: Vec<u16> = OsStr::new("NODE_SEA_BLOB")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe {
        UpdateResourceW(
            handle,
            RT_RCDATA,
            name_wide.as_ptr() as _,
            MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL),
            blob_data.as_ptr() as _,
            blob_data.len() as u32,
        )
    };

    if result == 0 {
        unsafe { EndUpdateResourceW(handle, TRUE) }; // discard changes
        anyhow::bail!(
            "UpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    // Finalize the resource update
    let result = unsafe { EndUpdateResourceW(handle, FALSE) };
    if result == 0 {
        anyhow::bail!(
            "EndUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    println!("  Injected NODE_SEA_BLOB resource ({})", blob_data.len());

    // Step 2: Set the sentinel fuse flag in the binary.
    //
    // Node.js embeds the sentinel fuse string in its binary:
    //   "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0"
    // The last byte is '0' before injection, '1' after. Node.js reads
    // this flag at startup to decide whether to look for the SEA blob.
    // Postject's JS wrapper does this as a post-injection step; we
    // replicate it here so the Rust tool produces a complete result.
    set_sentinel_fuse_flag(output)?;

    Ok(())
}

/// After the NODE_SEA_BLOB resource is injected, flip the sentinel fuse
/// byte from '0' to '1' so Node.js recognises the binary as a SEA app.
fn set_sentinel_fuse_flag(output: &str) -> anyhow::Result<()> {
    const SENTINEL_FUSE: &[u8] = b"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

    let mut binary = std::fs::read(output)
        .map_err(|e| anyhow::anyhow!("Failed to read back '{}': {}", output, e))?;

    // Search for the sentinel fuse string
    let pos = binary
        .windows(SENTINEL_FUSE.len())
        .position(|window| window == SENTINEL_FUSE)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Sentinel fuse not found in '{}'. Is this a Node.js SEA-enabled binary?",
                output
            )
        })?;

    // The format is: SENTINEL_FUSE:0 or SENTINEL_FUSE:1
    let colon_pos = pos + SENTINEL_FUSE.len();
    if colon_pos >= binary.len() || binary[colon_pos] != b':' {
        anyhow::bail!(
            "Expected ':' after sentinel fuse at offset {} in '{}', got byte {:02x}",
            colon_pos,
            output,
            binary.get(colon_pos).copied().unwrap_or(0),
        );
    }

    let flag_pos = colon_pos + 1;
    if flag_pos >= binary.len() {
        anyhow::bail!("Unexpected EOF after sentinel fuse colon in '{}'", output);
    }

    match binary[flag_pos] {
        b'1' => {
            // Already set — nothing to do.
            println!("  Sentinel fuse already active");
        }
        b'0' => {
            binary[flag_pos] = b'1';
            std::fs::write(output, &binary)
                .map_err(|e| anyhow::anyhow!("Failed to write back '{}': {}", output, e))?;
            println!("  Sentinel fuse activated");
        }
        other => {
            anyhow::bail!(
                "Unexpected sentinel fuse value {:02x} at offset {} in '{}'",
                other,
                flag_pos,
                output,
            );
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn inject(_input: &str, _blob_data: &[u8], _output: &str) -> anyhow::Result<()> {
    anyhow::bail!("PE injection is only supported on Windows");
}

#[cfg(not(target_os = "windows"))]
fn set_sentinel_fuse_flag(_output: &str) -> anyhow::Result<()> {
    unreachable!("set_sentinel_fuse_flag is Windows-only");
}