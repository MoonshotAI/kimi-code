/**
 * Per-node tag model for the dep-graph viewer. Tags are user-authored labels
 * stuck onto service nodes so the graph can be grouped / focused by concerns
 * that the analyzer doesn't know about (team ownership, migration phase,
 * review status, …). They live entirely in the browser: persisted to
 * `localStorage` and keyed by `ServiceNode.id`, which is stable across
 * analyzer runs (`${scope}::${token}`).
 */

/** `ServiceNode.id` → tag list. Order is preserved as entered. */
export type TagMap = Record<string, string[]>;

const TAGS_STORAGE_KEY = 'agent-core-v2:dep-graph:tags';

export function loadTags(): TagMap {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isTagMap(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveTags(tags: TagMap): void {
  try {
    localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {
  }
}

function isTagMap(value: unknown): value is TagMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) return false;
  }
  return true;
}

export interface TagCount {
  tag: string;
  count: number;
}

export function collectTagCounts(tags: TagMap): TagCount[] {
  const counts = new Map<string, number>();
  for (const list of Object.values(tags)) {
    for (const tag of list) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function tagsEqual(tags: TagMap, nodeId: string, next: string[]): boolean {
  const cur = tags[nodeId];
  if (next.length === 0) return !(nodeId in tags);
  return cur !== undefined && cur.length === next.length && cur.every((t, i) => t === next[i]);
}

export function tagColor(tag: string): { color: string; bg: string } {
  const hue = ((hashString(tag) % 360) + 360) % 360;
  return {
    color: `hsl(${hue}, 65%, 72%)`,
    bg: `hsla(${hue}, 55%, 45%, 0.2)`,
  };
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ (s.codePointAt(i) ?? 0);
  return h;
}
