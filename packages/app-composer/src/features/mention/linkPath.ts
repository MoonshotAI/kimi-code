export function mentionHrefToPath(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}
