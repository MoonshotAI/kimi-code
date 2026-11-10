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
