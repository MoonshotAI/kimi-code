/**
 * `sandbox` domain (L3) — sandbox filesystem path-rule matching.
 *
 * Pure matchers shared by the sandbox permission policies (and reusable by
 * future sandbox consumers): `matchesPathRule` compares an absolute path
 * against one `filesystem.deny_read` / `deny_write` entry, and
 * `isWithinAnyRoot` tests containment in the resolved writable roots. An
 * entry matches its own path or anything beneath it — exact in practice for
 * files, a subtree mask for directories, mirroring the bwrap `--tmpfs` /
 * `/dev/null` masks; a trailing `/**` marks an explicit subtree root. Entries
 * are `~`-expanded against the host home directory and normalized;
 * containment goes through `isWithinDirectory`, so shared-prefix escapes
 * (`/foo-evil`) never match. Other glob syntax is not supported.
 */

import { normalize } from 'pathe';

import { isWithinDirectory } from '#/tool/path-access';

const SUBTREE_SUFFIX = '/**';

export function matchesPathRule(path: string, rule: string, homeDir: string): boolean {
  const expanded = expandHome(rule, homeDir);
  const base = expanded.endsWith(SUBTREE_SUFFIX)
    ? expanded.slice(0, -SUBTREE_SUFFIX.length)
    : expanded;
  const normalizedBase = normalize(base);
  if (normalizedBase === '') return false;
  return isWithinDirectory(path, normalizedBase);
}

export function isWithinAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithinDirectory(path, root));
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return `${homeDir}/${p.slice(2)}`;
  return p;
}
