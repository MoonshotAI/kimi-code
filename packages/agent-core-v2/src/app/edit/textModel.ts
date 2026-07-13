/**
 * `edit` domain — {@link TextModel}, the pure text/line-ending/match-replace
 * core of an edit.
 *
 * Wraps a raw file's text and exposes a normalized LF "model view" for matching
 * (so a pure CRLF file can be edited with an LF `old_string`), plus the
 * mechanical replace primitives. No IO, no business rules — {@link EditService}
 * owns uniqueness / `replace_all` / error messages, and `FileEditService` owns
 * the filesystem.
 */

import {
  type LineEndingStyle,
  materializeModelText,
  toModelTextView,
} from '#/_base/text/line-endings';

export class TextModel {
  /** Line-ending style detected in the raw file. */
  readonly lineEndingStyle: LineEndingStyle;
  /** LF-normalized view used for matching. */
  readonly text: string;

  constructor(raw: string) {
    const view = toModelTextView(raw);
    this.text = view.text;
    this.lineEndingStyle = view.lineEndingStyle;
  }

  /**
   * Count the non-overlapping occurrences of `needle` in the model view.
   * `needle` must be non-empty — `indexOf("", pos)` would loop forever.
   */
  countOccurrences(needle: string): number {
    let count = 0;
    let pos = 0;
    while (pos < this.text.length) {
      const idx = this.text.indexOf(needle, pos);
      if (idx === -1) break;
      count += 1;
      pos = idx + needle.length;
    }
    return count;
  }

  /**
   * Replace the first occurrence of `needle` with `replacement` in the model
   * view and return the new model text. Returns the model text unchanged when
   * `needle` is not present (callers that need uniqueness should check
   * {@link countOccurrences} first).
   */
  replaceOnce(needle: string, replacement: string): string {
    const index = this.text.indexOf(needle);
    if (index === -1) return this.text;
    return this.text.slice(0, index) + replacement + this.text.slice(index + needle.length);
  }

  /**
   * Replace every occurrence of `needle` with `replacement` in the model view.
   * Returns the new model text and the number of replacements made. Dollar
   * sequences in `replacement` are treated literally (split/join, not
   * `String#replace`).
   */
  replaceAll(needle: string, replacement: string): { text: string; count: number } {
    const parts = this.text.split(needle);
    return { text: parts.join(replacement), count: parts.length - 1 };
  }

  /**
   * Re-materialize a model-view string back to the raw on-disk line-ending
   * style — pure CRLF files round-trip to CRLF, mixed/lone-CR files stay on
   * the exact raw (LF) path.
   */
  materialize(modelText: string): string {
    return materializeModelText(modelText, this.lineEndingStyle);
  }
}
