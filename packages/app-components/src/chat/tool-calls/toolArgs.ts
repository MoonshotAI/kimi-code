
import { parsePartialArg } from '@moonshot-ai/app-core/lib';

export function parseArgRecord(arg: string): Record<string, unknown> | null {
  return parsePartialArg(arg);
}

function looksLikeJson(s: string): boolean {
  if (s === 'null' || /^\{\s*("|\}|$)/.test(s) || /^\[\s*("|\{|\]|-?\d|true\b|false\b|null\b|$)/.test(s)) return true;
  if (!/^[[{]/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function argFallbackText(arg: string): string {
  const s = (arg ?? '').replace(/^·\s*/, '').trim();
  return looksLikeJson(s) ? '' : s;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function argFilePath(d: Record<string, unknown> | null): string | undefined {
  if (!d) return undefined;
  return str(d.path) ?? str(d.file_path) ?? str(d.filePath) ?? str(d.filename);
}

export function pathDirname(p: string): string {
  const m = /^(.*)[\\/][^\\/]+[\\/]?$/.exec(p);
  return m?.[1] ?? '';
}

export function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}
