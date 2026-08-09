//! Line-level diff with context clustering — the approval preview's Edit
//! display block. TS `media/diff-preview` `renderDiffLinesClustered` parity
//! (LCS DP + change clusters + cap), minus ANSI styling: rows are plain
//! text and the chat renderer applies colors.

use crate::t;

/// Context rows around each change cluster (TS default `contextLines: 3`).
pub const DIFF_CONTEXT_LINES: usize = 3;
/// Cap for the approval-preview diff body (TS `DIFF_SUMMARY_MAX_LINES`).
pub const DIFF_SUMMARY_MAX_LINES: usize = 10;

/// Kind of a single diff row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Context,
    Add,
    Delete,
}

/// One diff row: kind, 1-based line number (new-file numbering for
/// context/add rows, old-file for delete rows), and the code text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub line_num: usize,
    pub code: String,
}

/// LCS-based line diff (TS `computeDiffLines` parity). Rows are emitted in
/// document order with line numbers offset by `old_start`/`new_start`.
pub fn compute_diff_lines(
    old_text: &str,
    new_text: &str,
    old_start: usize,
    new_start: usize,
) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = if old_text.is_empty() {
        Vec::new()
    } else {
        old_text.split('\n').collect()
    };
    let new_lines: Vec<&str> = if new_text.is_empty() {
        Vec::new()
    } else {
        new_text.split('\n').collect()
    };
    let (m, n) = (old_lines.len(), new_lines.len());

    // LCS DP table: dp[i][j] = LCS length of old[0..i] and new[0..j].
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if old_lines[i - 1] == new_lines[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    // Backtrack from the bottom-right corner, preferring matches, then
    // adds (new-only), then deletes (old-only).
    let mut reversed: Vec<DiffLine> = Vec::with_capacity(m + n);
    let (mut i, mut j) = (m, n);
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            reversed.push(DiffLine {
                kind: DiffKind::Context,
                line_num: new_start + j - 1,
                code: new_lines[j - 1].to_string(),
            });
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            reversed.push(DiffLine {
                kind: DiffKind::Add,
                line_num: new_start + j - 1,
                code: new_lines[j - 1].to_string(),
            });
            j -= 1;
        } else {
            reversed.push(DiffLine {
                kind: DiffKind::Delete,
                line_num: old_start + i - 1,
                code: old_lines[i - 1].to_string(),
            });
            i -= 1;
        }
    }
    reversed.reverse();
    reversed
}

/// Render the diff with context clustering: a `+N -M path` header, change
/// clusters separated by `… N unchanged line(s) …` rows, and the body
/// capped at `DIFF_SUMMARY_MAX_LINES` with a trailing "N more changes
/// hidden" hint (TS `renderDiffLinesClustered` parity, no ANSI styling).
/// An empty `path` renders the header as `+N -M` only (the caller usually
/// shows the tool line, e.g. `Edit: a.txt`).
pub fn render_diff_clustered(old_text: &str, new_text: &str, path: &str) -> Vec<String> {
    let diff = compute_diff_lines(old_text, new_text, 1, 1);
    let change_indices: Vec<usize> = diff
        .iter()
        .enumerate()
        .filter(|(_, l)| l.kind != DiffKind::Context)
        .map(|(i, _)| i)
        .collect();

    let added = change_indices
        .iter()
        .filter(|&&i| diff[i].kind == DiffKind::Add)
        .count();
    let removed = change_indices.len() - added;

    let mut out = Vec::new();
    let mut header = String::new();
    if added > 0 {
        header.push_str(&format!("+{added} "));
    }
    if removed > 0 {
        header.push_str(&format!("-{removed} "));
    }
    header.push_str(path);
    out.push(header.trim_end().to_string());

    if change_indices.is_empty() {
        return out;
    }

    // Merge change runs whose gap is at most 2× context into one cluster,
    // then pad each cluster with context rows (clamped to the diff).
    let merge_gap = 2 * DIFF_CONTEXT_LINES;
    let mut clusters: Vec<(usize, usize)> = Vec::new();
    let mut group_start = change_indices[0];
    let mut group_end = change_indices[0];
    for &idx in &change_indices[1..] {
        if idx - group_end <= merge_gap {
            group_end = idx;
        } else {
            clusters.push((
                group_start.saturating_sub(DIFF_CONTEXT_LINES),
                (group_end + DIFF_CONTEXT_LINES).min(diff.len() - 1),
            ));
            group_start = idx;
            group_end = idx;
        }
    }
    clusters.push((
        group_start.saturating_sub(DIFF_CONTEXT_LINES),
        (group_end + DIFF_CONTEXT_LINES).min(diff.len() - 1),
    ));

    let mut body = 0usize;
    let mut prev_end: Option<usize> = None;
    let mut truncated = false;
    let mut shown_changes = 0usize;

    'outer: for (start, end) in clusters {
        if body >= DIFF_SUMMARY_MAX_LINES {
            truncated = true;
            break;
        }
        if let Some(prev) = prev_end {
            if start > prev + 1 {
                let gap = start - prev - 1;
                if body + 1 > DIFF_SUMMARY_MAX_LINES {
                    truncated = true;
                    break;
                }
                out.push(format!("  {}", t!("tui.diff.unchangedLines", gap)));
                body += 1;
            }
        }
        for (i, line) in diff.iter().enumerate().skip(start).take(end - start + 1) {
            if body >= DIFF_SUMMARY_MAX_LINES {
                truncated = true;
                break 'outer;
            }
            let marker = match line.kind {
                DiffKind::Add => "+",
                DiffKind::Delete => "-",
                DiffKind::Context => " ",
            };
            out.push(format!("{:>4} {marker} {}", line.line_num, line.code));
            body += 1;
            if line.kind != DiffKind::Context {
                shown_changes += 1;
            }
            prev_end = Some(i);
        }
    }
    if truncated {
        let hidden = change_indices.len() - shown_changes;
        if hidden > 0 {
            out.push(format!("  {}", t!("tui.diff.moreChangesHidden", hidden)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lcs_backtrack_emits_ordered_rows() {
        // a unchanged, b deleted, x added, c unchanged.
        let diff = compute_diff_lines("a\nb\nc", "a\nx\nc", 1, 1);
        let kinds: Vec<DiffKind> = diff.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            vec![
                DiffKind::Context,
                DiffKind::Delete,
                DiffKind::Add,
                DiffKind::Context
            ]
        );
        // Delete rows carry the old line number, add rows the new one.
        assert_eq!(diff[1].line_num, 2);
        assert_eq!(diff[1].code, "b");
        assert_eq!(diff[2].line_num, 2);
        assert_eq!(diff[2].code, "x");
    }

    #[test]
    fn empty_inputs_diff_to_everything_added() {
        let diff = compute_diff_lines("", "a\nb", 1, 1);
        assert!(diff.iter().all(|l| l.kind == DiffKind::Add));
        assert_eq!(diff.len(), 2);
        let diff = compute_diff_lines("a\nb", "", 1, 1);
        assert!(diff.iter().all(|l| l.kind == DiffKind::Delete));
        assert_eq!(diff.len(), 2);
    }

    #[test]
    fn clustered_render_has_header_and_rows() {
        let lines = render_diff_clustered("a\nold\nc", "a\nnew\nc", "f.txt");
        assert_eq!(lines[0], "+1 -1 f.txt");
        assert!(lines.iter().any(|l| l.ends_with("- old")), "{lines:?}");
        assert!(lines.iter().any(|l| l.ends_with("+ new")), "{lines:?}");
    }

    #[test]
    fn far_changes_split_clusters_with_separator() {
        // Pin the locale: the separator row goes through the global t().
        crate::i18n::set_locale(crate::i18n::Locale::En);
        // Two changes 10 lines apart: > 2×context(3), so two clusters with
        // an unchanged-lines separator between them. The body cap (10) can
        // only fit the first cluster + the separator, so the second cluster
        // is truncated — the separator row is the thing under test.
        let old: Vec<String> = (0..16).map(|i| format!("line{i}")).collect();
        let mut new = old.clone();
        new[1] = "editA".into();
        new[13] = "editB".into();
        let lines = render_diff_clustered(&old.join("\n"), &new.join("\n"), "");
        assert_eq!(lines[0], "+2 -2", "stats header: {lines:?}");
        assert!(
            lines.iter().any(|l| l.ends_with("+ editA")),
            "first change shown: {lines:?}"
        );
        let separator = lines
            .iter()
            .find(|l| l.contains("unchanged line"))
            .expect("separator row")
            .clone();
        assert!(separator.contains("unchanged"), "sep: {separator}");
        assert!(
            lines.iter().any(|l| l.contains("more change")),
            "truncation hint: {lines:?}"
        );
    }

    #[test]
    fn body_caps_at_summary_max_lines() {
        crate::i18n::set_locale(crate::i18n::Locale::En);
        let old: Vec<String> = (0..50).map(|i| format!("old{i}")).collect();
        let new: Vec<String> = (0..50).map(|i| format!("new{i}")).collect();
        let lines = render_diff_clustered(&old.join("\n"), &new.join("\n"), "");
        assert_eq!(lines[0], "+50 -50");
        assert_eq!(lines.len(), DIFF_SUMMARY_MAX_LINES + 2, "{lines:?}");
        let hint = lines.last().unwrap();
        assert!(hint.contains("more change"), "hint: {hint}");
    }

    #[test]
    fn unchanged_input_renders_header_only() {
        let lines = render_diff_clustered("same", "same", "");
        assert_eq!(lines, vec![""]);
    }
}
