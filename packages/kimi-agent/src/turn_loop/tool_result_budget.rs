/// Tool result budgeting — persist oversized tool results to disk.
///
/// Corresponds to `packages/agent-core/src/agent/turn/tool-result-budget.ts`.

use std::path::{Path, PathBuf};

const MAX_INLINE_OUTPUT_LENGTH: usize = 4096;
const TOOL_OUTPUT_DIR: &str = ".kimi-code/tool-outputs";

/// Budget a tool result: if it's too large, persist it to disk and return
/// a preview with a path reference.
pub async fn budget_tool_result_for_model(
    output: &str,
    tool_call_id: &str,
    tool_name: &str,
    session_dir: Option<&Path>,
) -> String {
    if output.len() <= MAX_INLINE_OUTPUT_LENGTH {
        return output.to_string();
    }

    // Persist to disk and return a preview.
    let preview = match persist_tool_output(output, tool_call_id, tool_name, session_dir).await {
        Ok(path) => {
            format!(
                "<system>The tool output was too large to include inline. \
                 It has been saved to:\n  {}\n\n\
                 The first {} characters are shown below:</system>\n\n{}",
                path.display(),
                MAX_INLINE_OUTPUT_LENGTH,
                &output[..MAX_INLINE_OUTPUT_LENGTH]
            )
        }
        Err(_) => {
            // Fallback: truncate inline.
            format!(
                "{}\n\n<system>Tool output truncated at {} characters.</system>",
                &output[..MAX_INLINE_OUTPUT_LENGTH],
                MAX_INLINE_OUTPUT_LENGTH
            )
        }
    };

    preview
}

/// Persist oversized tool output to disk.
async fn persist_tool_output(
    output: &str,
    tool_call_id: &str,
    _tool_name: &str,
    session_dir: Option<&Path>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base_dir = match session_dir {
        Some(dir) => dir.join(TOOL_OUTPUT_DIR),
        None => {
            let tmp = std::env::temp_dir().join("kimi-code").join(TOOL_OUTPUT_DIR);
            tmp
        }
    };

    tokio::fs::create_dir_all(&base_dir).await?;

    let file_name = format!("{}.txt", tool_call_id);
    let file_path = base_dir.join(&file_name);

    tokio::fs::write(&file_path, output).await?;

    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_small_output_stays_inline() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(budget_tool_result_for_model(
            "small output",
            "call-1",
            "read",
            None,
        ));
        assert_eq!(result, "small output");
    }

    #[test]
    fn test_large_output_truncated() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let large = "x".repeat(MAX_INLINE_OUTPUT_LENGTH + 100);
        let result = rt.block_on(budget_tool_result_for_model(
            &large,
            "call-1",
            "read",
            None,
        ));
        // Should be truncated (either inline or persisted)
        assert!(result.len() < large.len() || result.contains("truncated") || result.contains("too large"));
    }
}