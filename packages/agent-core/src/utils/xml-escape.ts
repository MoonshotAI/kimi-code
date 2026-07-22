/** Escape XML content — escapes both tag and attribute boundary chars (& < > ") */
export function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escape XML attribute value — only escapes attribute boundary chars (& "), not tag chars */
export function escapeXmlAttr(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** Escape tag delimiters only — prevents XML tag injection without corrupting Markdown (& " stay literal) */
export function escapeXmlTags(input: string): string {
  return input.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escape workspace/user-controlled text before placing it inside an
 * `<untrusted_*>` wrapper. Removes control-plane characters that only
 * exist to spoof structure (NUL/C0, bidirectional overrides) and escapes
 * tag delimiters so embedded `</untrusted_…>` cannot close the wrapper.
 */
export function escapeUntrustedText(input: string): string {
  return sanitizeUntrustedControls(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Wrap payload in a named untrusted envelope. Empty input stays empty so
 * templates can still omit empty sections by checking content length.
 * `tag` must be a simple XML name (`untrusted_agents_md`, etc.).
 */
export function wrapUntrusted(tag: string, content: string): string {
  assertUntrustedTag(tag);
  if (content.length === 0) return '';
  return `<${tag}>\n${escapeUntrustedText(content)}\n</${tag}>`;
}

const UNTRUSTED_TAG_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function assertUntrustedTag(tag: string): void {
  if (!UNTRUSTED_TAG_RE.test(tag)) {
    throw new Error(`Invalid untrusted wrapper tag: ${tag}`);
  }
}

export function sanitizeUntrustedControls(input: string): string {
  // C0 controls except tab/LF/CR, DEL, and Unicode bidi/isolate overrides.
  return input
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replaceAll(/[\u202A-\u202E\u2066-\u2069]/g, '');
}
