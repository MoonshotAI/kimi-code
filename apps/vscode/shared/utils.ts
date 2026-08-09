export function cleanSystemTags(text: string): string {
  return text.replace(/<system>.*?<\/system>\s*/gs, "").trim();
}
