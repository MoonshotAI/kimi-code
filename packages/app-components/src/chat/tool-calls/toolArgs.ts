// Shared parsing helpers for the bespoke tool-call renderers: pull typed
// fields out of a tool's JSON-stringified `arg`, plus small path/URL
// formatters the row layouts reuse. Every helper is defensive and never
// throws — tool args arrive verbatim from the daemon and may be partial.

export function parseArgRecord(arg: string): Record<string, unknown> | null {
  const s = (arg ?? '').trim();
  if (!s.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Take a tool input's file path, regardless of which key the tool used. */
export function argFilePath(d: Record<string, unknown> | null): string | undefined {
  if (!d) return undefined;
  return str(d.path) ?? str(d.file_path) ?? str(d.filePath) ?? str(d.filename);
}

/** Everything before the final path segment ('' for bare file names). */
export function pathDirname(p: string): string {
  const m = /^(.*)[\\/][^\\/]+[\\/]?$/.exec(p);
  return m?.[1] ?? '';
}

/** Reduce a URL to "host[/first-segment]" for compact row display. */
export function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}
