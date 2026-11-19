export function fileUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    const path = decodeURIComponent(parsed.pathname);
    if (parsed.host !== '') return `\\\\${parsed.host}${path.replace(/\//g, '\\')}`;
    return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}
