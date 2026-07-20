import { bridge } from "@/services";

// Color Regex
const HEX_COLOR = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F\w])/;
const RGB_COLOR = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)/;
const HSL_COLOR = /hsla?\(\s*\d{1,3}\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+)?\s*\)/;

// File Path Regex
const FILE_PATH = /(?:@|\.\/)?(?:[a-zA-Z_][\w-]*\/)*[a-zA-Z_][\w-]*\.[a-zA-Z0-9]+/;

// Combined Regex
const ENRICHMENT_PATTERN = new RegExp(`(${HEX_COLOR.source}|${RGB_COLOR.source}|${HSL_COLOR.source})|(${FILE_PATH.source})`, "g");

// Color Regex for recognizing colors only within code tags
const COLOR_ONLY_PATTERN = new RegExp(`(${HEX_COLOR.source}|${RGB_COLOR.source}|${HSL_COLOR.source})`, "g");

export type Segment = { type: "text"; value: string } | { type: "color"; value: string } | { type: "file"; value: string; path: string };

function normalizePath(raw: string): string {
  let p = raw;
  if (p.startsWith("@")) {
    p = p.slice(1);
  }
  if (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

export function extractPaths(text: string): string[] {
  if (!text) {
    return [];
  }
  const seen = new Set<string>();
  const regex = new RegExp(FILE_PATH.source, "g");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    seen.add(normalizePath(m[0]));
  }
  return [...seen];
}

export function parseSegments(text: string, fileExistsMap: Record<string, boolean>): Segment[] {
  if (!text) {
    return [];
  }

  const segments: Segment[] = [];
  const regex = new RegExp(ENRICHMENT_PATTERN.source, "g");
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text))) {
    const [full, colorMatch, fileMatch] = m;

    if (m.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, m.index) });
    }

    if (colorMatch) {
      segments.push({ type: "color", value: colorMatch });
    } else if (fileMatch) {
      const path = normalizePath(fileMatch);
      segments.push(fileExistsMap[path] ? { type: "file", value: fileMatch, path } : { type: "text", value: fileMatch });
    }

    lastIndex = m.index + full.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: "text", value: text }];
}

export function parseColorSegments(text: string): Segment[] {
  if (!text) {
    return [];
  }

  const segments: Segment[] = [];
  const regex = new RegExp(COLOR_ONLY_PATTERN.source, "g");
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text))) {
    if (m.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, m.index) });
    }
    segments.push({ type: "color", value: m[0] });
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: "text", value: text }];
}

export function hasColors(text: string): boolean {
  return COLOR_ONLY_PATTERN.test(text);
}

// File Existence Cache
const CACHE_TTL = 10_000;
const fileExistsCache = new Map<string, { exists: boolean; ts: number }>();

export async function checkFilesExist(paths: string[]): Promise<Record<string, boolean>> {
  if (!paths.length) {
    return {};
  }

  const result: Record<string, boolean> = {};
  const uncached: string[] = [];
  const now = Date.now();

  for (const p of new Set(paths)) {
    const entry = fileExistsCache.get(p);
    if (entry && now - entry.ts < CACHE_TTL) {
      result[p] = entry.exists;
    } else {
      uncached.push(p);
    }
  }

  if (uncached.length) {
    try {
      const fetched = await bridge.checkFilesExist(uncached);
      for (const p of uncached) {
        const exists = fetched[p] ?? false;
        fileExistsCache.set(p, { exists, ts: now });
        result[p] = exists;
      }
    } catch {
      for (const p of uncached) {
        result[p] = false;
      }
    }
  }

  return result;
}

export function isLocalPath(src: string): boolean {
  return !!src && !src.startsWith("data:") && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("blob:");
}
