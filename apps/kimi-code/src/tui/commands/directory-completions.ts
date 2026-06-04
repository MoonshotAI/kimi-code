import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { AutocompleteItem } from '@earendil-works/pi-tui';

const MAX_DIRECTORY_COMPLETIONS = 50;

export function completeAddDirectoryArgument(
  argumentPrefix: string,
  workDir: string,
): AutocompleteItem[] | null {
  if (argumentPrefix.includes('"') || argumentPrefix.includes("'")) return null;

  const parsed = parseDirectoryPrefix(argumentPrefix, workDir);
  let entries;
  try {
    entries = readdirSync(parsed.searchDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const lowerPrefix = parsed.searchPrefix.toLowerCase();
  const items = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name.toLowerCase().startsWith(lowerPrefix))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DIRECTORY_COMPLETIONS)
    .map((entry) => {
      const value = directoryCompletionValue(argumentPrefix, entry.name);
      return {
        value,
        label: `${entry.name}/`,
        description: resolve(parsed.searchDir, entry.name),
      };
    });

  return items.length > 0 ? items : null;
}

export function completeRemoveDirectoryArgument(
  argumentPrefix: string,
  dirs: readonly string[],
): AutocompleteItem[] | null {
  const query = argumentPrefix.trim().toLowerCase();
  const items = dirs
    .filter((dir) => {
      if (query.length === 0) return true;
      return dir.toLowerCase().includes(query) || basename(dir).toLowerCase().includes(query);
    })
    .map((dir) => ({
      value: dir,
      label: basename(dir) || dir,
      description: dir,
    }));

  const [only] = items;
  if (items.length === 1 && only !== undefined && only.value.toLowerCase() === query) {
    return null;
  }
  return items.length > 0 ? items : null;
}

function parseDirectoryPrefix(
  argumentPrefix: string,
  workDir: string,
): { searchDir: string; searchPrefix: string } {
  const expanded = expandHome(argumentPrefix);
  if (argumentPrefix.length === 0 || endsWithSeparator(argumentPrefix)) {
    return {
      searchDir: resolvePath(workDir, expanded),
      searchPrefix: '',
    };
  }

  const dir = dirname(expanded);
  return {
    searchDir: resolvePath(workDir, dir === '.' ? '' : dir),
    searchPrefix: basename(expanded),
  };
}

function directoryCompletionValue(argumentPrefix: string, entryName: string): string {
  if (argumentPrefix.length === 0) return `${entryName}${sep}`;
  if (endsWithSeparator(argumentPrefix)) return `${argumentPrefix}${entryName}${sep}`;

  const dir = dirname(argumentPrefix);
  if (dir === '.') return `${entryName}${sep}`;
  return `${join(dir, entryName)}${sep}`;
}

function resolvePath(workDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workDir, path);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  if (sep === '\\' && path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function endsWithSeparator(path: string): boolean {
  return path.endsWith('/') || path.endsWith('\\');
}
