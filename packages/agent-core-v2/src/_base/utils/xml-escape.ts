/**
 * XML escaping helpers for content, attribute values, and tag delimiters.
 */

export function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function escapeXmlAttr(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export function escapeXmlTags(input: string): string {
  return input.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
