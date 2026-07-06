/**
 * Strip `<system>...</system>` blocks from text for UI display.
 *
 * Tool results and user messages may carry `<system>` blocks as side-channel
 * notes meant for the model — ReadMediaFile's mime/dimension summary, or the
 * tool error/empty status sentinels (`<system>ERROR: …</system>`,
 * `<system>Tool output is empty.</system>`). They must stay in history (the
 * model reads them) but should never render in user-facing UIs. Call this at
 * every core→UI output boundary — the server protocol mapper, the live event
 * mapper, and the TUI output component — so the stripping rule lives in exactly
 * one place instead of being reimplemented per UI.
 *
 * Only well-formed, paired tags are removed. A lone `<system>` without its
 * closing `</system>` is left untouched, so user data that merely contains the
 * literal substring is not eaten.
 */
import type { ContentPart } from '@moonshot-ai/kosong';

const SYSTEM_TAG_RE = /<system>[\s\S]*?<\/system>/g;

export function stripSystemTags(text: string): string {
  if (!text.includes('<system>')) return text;
  return text.replace(SYSTEM_TAG_RE, '');
}

/**
 * Strip `<system>` blocks from a tool result's `output`, which may be a plain
 * string or a list of content parts (only `text` parts carry tags). Returns a
 * value of the same shape; non-text parts pass through unchanged.
 */
export function stripSystemFromOutput(output: string | ContentPart[]): string | ContentPart[] {
  if (typeof output === 'string') return stripSystemTags(output);
  return output.map((part) =>
    part.type === 'text' ? { ...part, text: stripSystemTags(part.text) } : part,
  );
}
