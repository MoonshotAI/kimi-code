import { normalize } from 'pathe';

export interface PorcelainWorktree {
  readonly path: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly bare: boolean;
  readonly prunable: boolean;
}

const BRANCH_PREFIX = 'refs/heads/';

export function parseWorktreeList(output: string): readonly PorcelainWorktree[] {
  const entries: PorcelainWorktree[] = [];
  for (const block of output.replaceAll('\r\n', '\n').split('\n\n')) {
    const attributes = new Map<string, string>();
    for (const line of block.split('\n')) {
      if (line === '') continue;
      const space = line.indexOf(' ');
      attributes.set(space === -1 ? line : line.slice(0, space), space === -1 ? '' : line.slice(space + 1));
    }
    const path = attributes.get('worktree');
    if (path === undefined) continue;
    const head = attributes.get('HEAD');
    const branch = attributes.get('branch');
    entries.push({
      path: normalize(path),
      head: head === undefined || /^0+$/.test(head) ? undefined : head,
      branch: branch?.startsWith(BRANCH_PREFIX) === true ? branch.slice(BRANCH_PREFIX.length) : branch,
      bare: attributes.has('bare'),
      prunable: attributes.has('prunable'),
    });
  }
  return entries;
}

export function splitNul(output: string): string[] {
  return output.split('\0').filter((field) => field !== '');
}

export function countStatusEntries(output: string): number {
  const fields = splitNul(output);
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    count++;
    if (/[RC]/.test(fields[i]!.slice(0, 2))) i++;
  }
  return count;
}

export interface HiddenIndexEntry {
  readonly path: string;
  readonly object: string;
  readonly skipWorktree: boolean;
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

export function hiddenIndexEntries(output: string): HiddenIndexEntry[] {
  const entries: HiddenIndexEntry[] = [];
  for (const field of splitNul(output)) {
    const tab = field.indexOf('\t');
    const [tag = '', mode = '', object = ''] = field.slice(0, tab).split(' ');
    const skipWorktree = tag === 'S';
    const hidden = skipWorktree || tag !== tag.toUpperCase();
    if (tab !== -1 && hidden && REGULAR_FILE_MODES.has(mode)) {
      entries.push({ path: field.slice(tab + 1), object, skipWorktree });
    }
  }
  return entries;
}
