import { realpath } from 'node:fs/promises';

import { gitText, runGit } from './command';

export type RemoteBranchSource = 'upstream' | 'same_name';

export interface RemoteBranchRef {
  readonly remote: string;
  readonly source: RemoteBranchSource;
  readonly ref: string;
  readonly remoteRef: string;
  readonly trackingRef: string;
}

export interface LocalBranch {
  readonly name: string;
  readonly committedAt: string;
  readonly remote?: RemoteBranchRef;
}

export interface RepoBranches {
  readonly headBranch?: string;
  readonly remotes: readonly string[];
  readonly branches: readonly LocalBranch[];
}

const HEADS_PREFIX = 'refs/heads/';
const REMOTES_PREFIX = 'refs/remotes/';

async function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

export async function repoTopLevel(directory: string): Promise<string | undefined> {
  const top = await gitText(directory, ['rev-parse', '--show-toplevel']);
  return top === undefined || top.length === 0 ? undefined : top;
}

export async function isRepoRoot(directory: string): Promise<boolean> {
  const top = await repoTopLevel(directory);
  if (top === undefined) return false;
  return (await realpathOrSelf(top)) === (await realpathOrSelf(directory));
}

export async function isDirty(directory: string): Promise<boolean> {
  const status = await runGit(directory, ['status', '--porcelain', '--untracked-files=normal']);
  return status.exitCode === 0 && status.stdout.trim().length > 0;
}

export async function headBranch(directory: string): Promise<string | undefined> {
  const head = await gitText(directory, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return head === undefined || head.length === 0 ? undefined : head;
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(repoRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `${HEADS_PREFIX}${branch}`,
  ]);
  return result.exitCode === 0;
}

interface RemoteLookup {
  readonly trackingRefs: ReadonlySet<string>;
  readonly remotes: readonly string[];
  readonly defaultRemote?: string;
}

async function readRemoteLookup(repoRoot: string): Promise<RemoteLookup> {
  const [remotes, tracking, defaultRemote] = await Promise.all([
    gitText(repoRoot, ['remote']),
    gitText(repoRoot, ['for-each-ref', '--format=%(refname)', REMOTES_PREFIX]),
    gitText(repoRoot, ['config', '--get', 'checkout.defaultRemote']),
  ]);
  return {
    remotes: (remotes ?? '').split('\n').filter((line) => line.length > 0),
    trackingRefs: new Set((tracking ?? '').split('\n').filter((line) => line.length > 0)),
    defaultRemote: defaultRemote === undefined || defaultRemote.length === 0 ? undefined : defaultRemote,
  };
}

function sameNamedRemote(branch: string, lookup: RemoteLookup): RemoteBranchRef | undefined {
  const candidates = lookup.remotes.filter((remote) =>
    lookup.trackingRefs.has(`${REMOTES_PREFIX}${remote}/${branch}`),
  );
  const remote =
    candidates.length === 1
      ? candidates[0]
      : (candidates.find((candidate) => candidate === lookup.defaultRemote) ??
        candidates.find((candidate) => candidate === 'origin'));
  if (remote === undefined) return undefined;
  return {
    remote,
    source: 'same_name',
    ref: `${remote}/${branch}`,
    remoteRef: `${HEADS_PREFIX}${branch}`,
    trackingRef: `${REMOTES_PREFIX}${remote}/${branch}`,
  };
}

function upstreamRemote(
  remoteName: string,
  remoteRef: string,
  trackingRef: string,
): RemoteBranchRef | undefined {
  if (remoteName.length === 0 || remoteName === '.') return undefined;
  if (!remoteRef.startsWith(HEADS_PREFIX) || !trackingRef.startsWith(REMOTES_PREFIX)) return undefined;
  return {
    remote: remoteName,
    source: 'upstream',
    ref: trackingRef.slice(REMOTES_PREFIX.length),
    remoteRef,
    trackingRef,
  };
}

export async function listLocalBranches(repoRoot: string): Promise<RepoBranches> {
  const [refs, lookup, head] = await Promise.all([
    gitText(repoRoot, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(committerdate:unix)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
      HEADS_PREFIX,
    ]),
    readRemoteLookup(repoRoot),
    headBranch(repoRoot),
  ]);
  const branches: LocalBranch[] = [];
  for (const line of (refs ?? '').split('\n')) {
    const [refname, unix, remoteName, remoteRef, trackingRef] = line.split('\0');
    if (refname === undefined || !refname.startsWith(HEADS_PREFIX)) continue;
    const name = refname.slice(HEADS_PREFIX.length);
    const seconds = Number.parseInt(unix ?? '', 10);
    branches.push({
      name,
      committedAt: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0).toISOString(),
      remote:
        upstreamRemote(remoteName ?? '', remoteRef ?? '', trackingRef ?? '') ??
        sameNamedRemote(name, lookup),
    });
  }
  return { headBranch: head, remotes: lookup.remotes, branches };
}

export async function resolveRemoteRef(
  repoRoot: string,
  branch: string,
): Promise<RemoteBranchRef | undefined> {
  const [upstream, lookup] = await Promise.all([
    gitText(repoRoot, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
      `${HEADS_PREFIX}${branch}`,
    ]),
    readRemoteLookup(repoRoot),
  ]);
  const [remoteName, remoteRef, trackingRef] = (upstream ?? '').split('\n')[0]!.split('\0');
  return (
    upstreamRemote(remoteName ?? '', remoteRef ?? '', trackingRef ?? '') ??
    sameNamedRemote(branch, lookup)
  );
}

export interface TakenBranchNames {
  has(name: string): boolean;
}

export async function takenBranchNames(repoRoot: string): Promise<TakenBranchNames> {
  const [refs, remotes] = await Promise.all([
    gitText(repoRoot, ['for-each-ref', '--format=%(refname)', HEADS_PREFIX, REMOTES_PREFIX]),
    gitText(repoRoot, ['remote']),
  ]);
  const remoteNames = (remotes ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length);
  const taken = new Set<string>();
  for (const refname of (refs ?? '').split('\n')) {
    if (refname.startsWith(HEADS_PREFIX)) {
      taken.add(refname.slice(HEADS_PREFIX.length));
      continue;
    }
    if (!refname.startsWith(REMOTES_PREFIX)) continue;
    const rest = refname.slice(REMOTES_PREFIX.length);
    const remote = remoteNames.find((name) => rest.startsWith(`${name}/`));
    taken.add(remote === undefined ? rest.slice(rest.indexOf('/') + 1) : rest.slice(remote.length + 1));
  }
  return taken;
}

export interface LinkedWorktree {
  readonly path: string;
  readonly branch?: string;
  readonly main: boolean;
  readonly prunable: boolean;
}

export async function listWorktrees(repoRoot: string): Promise<readonly LinkedWorktree[]> {
  const out = await gitText(repoRoot, ['worktree', 'list', '--porcelain']);
  if (out === undefined) return [];
  const worktrees: LinkedWorktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    let path: string | undefined;
    let branch: string | undefined;
    let prunable = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branch = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
      } else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
    }
    if (path === undefined) continue;
    worktrees.push({ path, branch, main: worktrees.length === 0, prunable });
  }
  return worktrees;
}
