// ── Native module loading (lazy, with TS fallback) ──────────────────────────

let nativeModule: {
  nativeEscapeXml?: (text: string) => string;
  nativeEscapeXmlAttr?: (text: string) => string;
  nativeEscapeXmlTags?: (text: string) => string;
} | null | undefined;

function getNative() {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

/** Escape XML content — escapes both tag and attribute boundary chars (& < > ") */
export function escapeXml(input: string): string {
  const mod = getNative();
  if (mod?.nativeEscapeXml) return mod.nativeEscapeXml(input);
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escape XML attribute value — only escapes attribute boundary chars (& "), not tag chars */
export function escapeXmlAttr(input: string): string {
  const mod = getNative();
  if (mod?.nativeEscapeXmlAttr) return mod.nativeEscapeXmlAttr(input);
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** Escape tag delimiters only — prevents XML tag injection without corrupting Markdown (& " stay literal) */
export function escapeXmlTags(input: string): string {
  const mod = getNative();
  if (mod?.nativeEscapeXmlTags) return mod.nativeEscapeXmlTags(input);
  return input.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
