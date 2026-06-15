export function cleanSystemTags(text: string): string {
  return text.replace(/<(system-reminder|system)\b[^>]*>[\s\S]*?<\/\1>\s*/gi, "").trim();
}
