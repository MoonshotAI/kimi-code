import { basename, dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import type { AbsoluteDir } from '#/_base/utils/workdir-slug';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface GitWorkTree {
  readonly root: string;
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

interface GitMarkerPlace {
  readonly root: string;
  readonly dotGitPath: string;
}

export type GitMarker =
  | (GitMarkerPlace & { readonly kind: 'directory' })
  | (GitMarkerPlace & { readonly kind: 'pointer'; readonly gitDir: string })
  | (GitMarkerPlace & { readonly kind: 'invalid' });

export async function findGitWorkTree(
  fs: IHostFileSystem,
  cwd: string,
): Promise<GitWorkTree | null> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return null;

  let current = normalize(cwd);
  while (true) {
    const dotGitPath = join(current, '.git');
    const controlDirPath = await probeGitControlDir(fs, dotGitPath, current);
    if (controlDirPath !== null) return { root: current, dotGitPath, controlDirPath };

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function findNearestGitMarker(
  fs: IHostFileSystem,
  start: string,
): Promise<GitMarker | undefined> {
  let current = normalize(start);
  while (true) {
    const dotGitPath = join(current, '.git');
    if (await pathExists(fs, dotGitPath)) return classifyGitMarker(fs, current, dotGitPath);

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function classifyGitMarker(
  fs: IHostFileSystem,
  root: string,
  dotGitPath: string,
): Promise<GitMarker> {
  const gitDir = await probeGitControlDir(fs, dotGitPath, root);
  if (gitDir === null) return { kind: 'invalid', root, dotGitPath };
  return gitDir === dotGitPath
    ? { kind: 'directory', root, dotGitPath }
    : { kind: 'pointer', root, dotGitPath, gitDir };
}

async function pathExists(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function probeGitControlDir(
  fs: IHostFileSystem,
  dotGitPath: string,
  markerParent: string,
): Promise<string | null> {
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory) return dotGitPath;
    if (!stat.isFile) return null;

    const content = await fs.readText(dotGitPath);
    return parseGitDirPointer(content, markerParent) ?? null;
  } catch {
    return null;
  }
}

function parseGitDirPointer(content: string, markerParent: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;

  const rawPath = line.slice('gitdir:'.length).trim();
  if (rawPath.length === 0) return undefined;
  return normalize(isAbsolute(rawPath) ? rawPath : join(markerParent, rawPath));
}

type UnreadableReason = 'unreadable-dotgit' | 'invalid-gitdir' | 'incomplete-worktree-metadata';

export type OwnReason = 'not-a-repo' | 'main-unknown' | UnreadableReason;

export type RejectReason = 'registered-path-not-dotgit' | 'backpointer-mismatch' | 'core-worktree-mismatch';

export type CheckoutLocation =
  | {
      readonly kind: 'grouped';
      readonly checkoutRoot: AbsoluteDir;
      readonly mainDir: AbsoluteDir;
      readonly canonicalMainDir: AbsoluteDir;
    }
  | { readonly kind: 'own'; readonly reason: OwnReason; readonly checkoutRoot?: AbsoluteDir }
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly checkoutRoot: AbsoluteDir };

export type GroupedCheckout = Extract<CheckoutLocation, { readonly kind: 'grouped' }>;

export type DegradedLocation =
  | Extract<CheckoutLocation, { readonly kind: 'rejected' }>
  | { readonly kind: 'own'; readonly reason: UnreadableReason; readonly checkoutRoot: AbsoluteDir };

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;

export function isDegradedLocation(location: CheckoutLocation): location is DegradedLocation {
  if (location.kind === 'rejected') return true;
  return location.kind === 'own' && location.reason !== 'not-a-repo' && location.reason !== 'main-unknown';
}

export async function locateCheckout(fs: IHostFileSystem, dir: AbsoluteDir): Promise<CheckoutLocation> {
  const marker = await findNearestGitMarker(fs, dir);
  if (marker === undefined) return { kind: 'own', reason: 'not-a-repo' };
  const checkoutRoot = marker.root as AbsoluteDir;
  if (marker.kind === 'invalid') return { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot };
  if (marker.kind === 'directory') {
    return (await holdsHead(fs, marker.dotGitPath))
      ? groupedAt(fs, checkoutRoot)
      : { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot };
  }

  const pointerFile = await lstatOrUndefined(fs, marker.dotGitPath);
  if (pointerFile === undefined || !isPlainSmallFile(pointerFile, MAX_POINTER_BYTES)) {
    return { kind: 'own', reason: 'unreadable-dotgit', checkoutRoot };
  }
  const gitDirStat = await lstatOrUndefined(fs, marker.gitDir);
  const canonicalGitDir = await realpathOrEmpty(fs, marker.gitDir);
  if (
    gitDirStat?.isDirectory !== true ||
    gitDirStat.isSymbolicLink === true ||
    canonicalGitDir === '' ||
    !(await holdsHead(fs, canonicalGitDir))
  ) {
    return { kind: 'own', reason: 'invalid-gitdir', checkoutRoot };
  }
  if (basename(dirname(canonicalGitDir)) !== 'worktrees') return groupedAt(fs, checkoutRoot);

  const common = dirname(dirname(canonicalGitDir));
  const [backPointer, commonPointer] = await Promise.all([
    readSmallText(fs, join(canonicalGitDir, 'gitdir'), MAX_POINTER_BYTES),
    readSmallText(fs, join(canonicalGitDir, 'commondir'), MAX_POINTER_BYTES),
  ]);
  if (backPointer === undefined || commonPointer === undefined) {
    return { kind: 'own', reason: 'incomplete-worktree-metadata', checkoutRoot };
  }
  const registeredDotGit = resolve(canonicalGitDir, backPointer.trim());
  if (basename(registeredDotGit) !== '.git') {
    return { kind: 'rejected', reason: 'registered-path-not-dotgit', checkoutRoot };
  }
  const [registered, self, linkedCommon] = await Promise.all([
    realpathOrEmpty(fs, dirname(registeredDotGit)),
    realpathOrEmpty(fs, checkoutRoot),
    realpathOrEmpty(fs, resolve(canonicalGitDir, commonPointer.trim())),
  ]);
  if (!sameRealpath(registered, self) || !sameRealpath(linkedCommon, common)) {
    return { kind: 'rejected', reason: 'backpointer-mismatch', checkoutRoot };
  }

  const mainCheckout = dirname(common);
  if (await pointsTo(fs, mainCheckout, common)) {
    return grouped(checkoutRoot, await writtenOr(fs, writtenMainCheckout(marker.gitDir), mainCheckout), mainCheckout);
  }
  const core = await readCoreConfig(fs, common);
  if (core.bare === true) {
    return grouped(checkoutRoot, await writtenOr(fs, writtenCommonDir(marker.gitDir), common), common);
  }
  if (core.worktree === undefined) return { kind: 'own', reason: 'main-unknown', checkoutRoot };
  const coreWorktree = await realpathOrEmpty(fs, resolve(common, core.worktree));
  if (coreWorktree !== '' && (await pointsTo(fs, coreWorktree, common))) {
    return grouped(checkoutRoot, coreWorktree, coreWorktree);
  }
  return { kind: 'rejected', reason: 'core-worktree-mismatch', checkoutRoot };
}

async function holdsHead(fs: IHostFileSystem, gitDir: string): Promise<boolean> {
  return (await lstatOrUndefined(fs, join(gitDir, 'HEAD'))) !== undefined;
}

async function groupedAt(fs: IHostFileSystem, checkoutRoot: AbsoluteDir): Promise<GroupedCheckout> {
  const canonical = await realpathOrEmpty(fs, checkoutRoot);
  return grouped(checkoutRoot, checkoutRoot, canonical === '' ? checkoutRoot : canonical);
}

function grouped(checkoutRoot: AbsoluteDir, mainDir: string, canonicalMainDir: string): GroupedCheckout {
  return {
    kind: 'grouped',
    checkoutRoot,
    mainDir: mainDir as AbsoluteDir,
    canonicalMainDir: canonicalMainDir as AbsoluteDir,
  };
}

function writtenCommonDir(gitDir: string): string | undefined {
  return basename(dirname(gitDir)) === 'worktrees' ? dirname(dirname(gitDir)) : undefined;
}

function writtenMainCheckout(gitDir: string): string | undefined {
  const common = writtenCommonDir(gitDir);
  return common === undefined ? undefined : dirname(common);
}

async function writtenOr(fs: IHostFileSystem, written: string | undefined, canonical: string): Promise<string> {
  if (written === undefined) return canonical;
  return sameRealpath(await realpathOrEmpty(fs, written), canonical) ? written : canonical;
}

async function pointsTo(fs: IHostFileSystem, checkout: string, common: string): Promise<boolean> {
  const dotGitPath = join(checkout, '.git');
  const marker = await lstatOrUndefined(fs, dotGitPath);
  if (marker === undefined) return false;
  if (marker.isDirectory && marker.isSymbolicLink !== true) {
    return sameRealpath(await realpathOrEmpty(fs, dotGitPath), common);
  }
  const text = await readSmallText(fs, dotGitPath, MAX_POINTER_BYTES);
  const pointed = text === undefined ? undefined : parseGitDirPointer(text, checkout);
  return pointed !== undefined && sameRealpath(await realpathOrEmpty(fs, pointed), common);
}

interface CoreConfig {
  readonly bare?: boolean;
  readonly worktree?: string;
}

async function readCoreConfig(fs: IHostFileSystem, common: string): Promise<CoreConfig> {
  const [shared, ownWorktree] = await Promise.all([
    readCoreSection(fs, join(common, 'config')),
    readCoreSection(fs, join(common, 'config.worktree')),
  ]);
  return { ...shared, ...ownWorktree };
}

async function readCoreSection(fs: IHostFileSystem, path: string): Promise<CoreConfig> {
  const text = await readSmallText(fs, path, MAX_CONFIG_BYTES);
  return text === undefined ? {} : parseCoreConfig(text);
}

function parseCoreConfig(text: string): CoreConfig {
  let bare: boolean | undefined;
  let worktree: string | undefined;
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inCore = /^\[\s*core\s*\]$/i.test(line);
      continue;
    }
    const entry = inCore ? /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line) : null;
    if (entry === null) continue;
    const value = entry[2] ?? 'true';
    const key = entry[1]!.toLowerCase();
    if (key === 'bare') bare = /^(?:true|yes|on|1)$/i.test(value);
    if (key === 'worktree') worktree = value;
  }
  return { ...(bare === undefined ? {} : { bare }), ...(worktree === undefined ? {} : { worktree }) };
}

function isPlainSmallFile(stat: HostFileStat, maxBytes: number): boolean {
  return stat.isFile && stat.isSymbolicLink !== true && stat.size <= maxBytes;
}

async function readSmallText(fs: IHostFileSystem, path: string, maxBytes: number): Promise<string | undefined> {
  const stat = await lstatOrUndefined(fs, path);
  if (stat === undefined || !isPlainSmallFile(stat, maxBytes)) return undefined;
  try {
    return await fs.readText(path);
  } catch {
    return undefined;
  }
}

function sameRealpath(a: string, b: string): boolean {
  return a !== '' && a === b;
}

async function realpathOrEmpty(fs: IHostFileSystem, path: string): Promise<string> {
  try {
    return normalize(await fs.realpath(path));
  } catch {
    return '';
  }
}

async function lstatOrUndefined(fs: IHostFileSystem, path: string): Promise<HostFileStat | undefined> {
  try {
    return await fs.lstat(path);
  } catch {
    return undefined;
  }
}
