/**
 * XML escaping helpers for content, attribute values, and tag delimiters.
 */
import { tryNativeEscapeXml, tryNativeEscapeXmlAttr, tryNativeEscapeXmlTags } from '#/_base/native-tools';

export function escapeXml(input: string): string {
  const native = tryNativeEscapeXml(input);
  if (native !== undefined) return native;
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function escapeXmlAttr(input: string): string {
  const native = tryNativeEscapeXmlAttr(input);
  if (native !== undefined) return native;
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export function escapeXmlTags(input: string): string {
  const native = tryNativeEscapeXmlTags(input);
  if (native !== undefined) return native;
  return input.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
