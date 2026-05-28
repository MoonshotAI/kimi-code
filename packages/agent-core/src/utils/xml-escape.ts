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
