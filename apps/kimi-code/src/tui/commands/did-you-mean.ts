import { isExperimentalFlagEnabled } from './experimental-flags';
import { BUILTIN_SLASH_COMMANDS } from './registry';
import type { KimiSlashCommand } from './types';

/** An unknown `/token` suggests candidates at most this edit distance away. */
const MAX_SUGGESTION_DISTANCE = 2;
const MAX_SUGGESTIONS = 3;

/**
 * The names a leading `/token` can currently resolve to: experiment-enabled
 * built-in command names and aliases, skill command keys, and plugin command
 * keys. This is the did-you-mean candidate pool and the set the editor uses to
 * decide whether the leading token paints as a command.
 */
export function knownSlashCommandNames(
  skillCommandMap: ReadonlyMap<string, string>,
  pluginCommandMap: ReadonlyMap<string, string>,
): Set<string> {
  const names = new Set<string>();
  for (const command of BUILTIN_SLASH_COMMANDS) {
    // `command` is a literal union where only some members carry
    // `experimentalFlag`; widen to read it (same as resolve.ts).
    if (!isExperimentalFlagEnabled((command as KimiSlashCommand).experimentalFlag)) continue;
    names.add(command.name);
    for (const alias of command.aliases) names.add(alias);
  }
  for (const key of skillCommandMap.keys()) names.add(key);
  for (const key of pluginCommandMap.keys()) names.add(key);
  return names;
}

/**
 * Up to `MAX_SUGGESTIONS` candidates within `MAX_SUGGESTION_DISTANCE` edits of
 * `name`, ordered by distance then name so the list is deterministic.
 */
export function suggestSlashCommands(name: string, candidates: ReadonlySet<string>): string[] {
  const scored: Array<{ candidate: string; distance: number }> = [];
  for (const candidate of candidates) {
    const distance = damerauLevenshteinDistance(name, candidate);
    if (distance <= MAX_SUGGESTION_DISTANCE) scored.push({ candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, MAX_SUGGESTIONS).map(({ candidate }) => candidate);
}

/** Optimal-string-alignment Damerau-Levenshtein: one transposition counts as a single edit. */
function damerauLevenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (j === 0 ? i : i === 0 ? j : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1, dist[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dist[i]![j] = Math.min(dist[i]![j]!, dist[i - 2]![j - 2]! + 1);
      }
    }
  }
  return dist[a.length]![b.length]!;
}
