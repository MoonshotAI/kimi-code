/**
 * `skillCatalog` domain (L3) — skill-root candidate watcher.
 *
 * Watches a dynamic set of skill-root candidates (existing or not) through
 * the os `IHostFsWatchService` and re-fires one debounced callback. An
 * existing candidate gets a depth-bounded recursive watch on its realpath
 * that follows nested symlink bundles; a symlinked candidate also keeps a
 * shallow lexical-parent anchor so deletion and retargeting rebind the target.
 * Missing candidates follow their lexical and last-known target ancestor
 * chains until the directory appears. Events are debounced and pruned to the
 * discovery traversal policy. Plain helper constructed and disposed by its
 * owner — not a scoped service.
 */

import { dirname, join, normalize, relative } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { TimeoutTimer } from '#/_base/utils/timer';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

import { isSkillTraversalDirectory, SKILL_SCAN_MAX_DEPTH } from './skillTraversal';

const WATCH_DEBOUNCE_MS = 300;

interface WatchEntry {
  readonly plan: WatchPlan;
  readonly handles: readonly IHostFsWatchHandle[];
}

type WatchPlan =
  | {
      readonly kind: 'target';
      readonly targetPath: string;
      readonly anchors: readonly WatchAnchor[];
    }
  | {
      readonly kind: 'anchor';
      readonly anchors: readonly WatchAnchor[];
    };

interface WatchAnchor {
  readonly watchedPath: string;
  readonly candidatePath?: string;
}

interface ExistingDir {
  readonly lexicalPath: string;
  readonly realPath: string;
}

export class SkillRootWatcher extends Disposable {
  private readonly entries = new Map<string, WatchEntry>();
  private candidates = new Set<string>();
  private readonly debounce = this._register(new TimeoutTimer());
  private armTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly hostFsWatch: IHostFsWatchService,
    private readonly hostFs: IHostFileSystem,
    private readonly onChanged: () => void,
  ) {
    super();
  }

  async setPaths(candidates: readonly string[]): Promise<void> {
    const next = new Set(candidates.map(normalizePath));
    this.candidates = next;
    for (const [candidate, entry] of this.entries) {
      if (next.has(candidate)) continue;
      disposeEntry(entry);
      this.entries.delete(candidate);
    }
    const arming: Promise<void>[] = [];
    for (const candidate of next) {
      arming.push(this.enqueue(() => this.rebind(candidate)));
    }
    await Promise.all(arming);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.candidates.clear();
    for (const entry of this.entries.values()) disposeEntry(entry);
    this.entries.clear();
    super.dispose();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.armTail.then(operation);
    this.armTail = next.catch(() => undefined);
    return next;
  }

  private async rebind(candidate: string): Promise<void> {
    if (this.disposed || !this.candidates.has(candidate)) return;
    const current = this.entries.get(candidate);
    const plan = await this.resolvePlan(candidate, current?.plan);
    if (
      this.disposed ||
      !this.candidates.has(candidate) ||
      this.entries.get(candidate) !== current ||
      plan === undefined
    ) {
      return;
    }
    if (current !== undefined && samePlan(current.plan, plan)) return;

    const replacement = this.createEntry(candidate, plan);
    if (this.disposed || !this.candidates.has(candidate) || this.entries.get(candidate) !== current) {
      disposeEntry(replacement);
      return;
    }
    this.entries.set(candidate, replacement);
    if (current !== undefined) disposeEntry(current);
    if (current?.plan.kind === 'anchor' && plan.kind === 'target') this.schedule();
  }

  private createEntry(candidate: string, plan: WatchPlan): WatchEntry {
    const handles: IHostFsWatchHandle[] = [];
    const entry: WatchEntry = { plan, handles };
    try {
      if (plan.kind === 'target') {
        const targetHandle = this.hostFsWatch.watch(plan.targetPath, {
          recursive: true,
          followSymlinks: true,
          depth: SKILL_SCAN_MAX_DEPTH,
          ignored: skillTreeIgnored(plan.targetPath),
        });
        handles.push(targetHandle);
        targetHandle.onDidChange((change) => this.onTargetChange(candidate, entry, change));
      }

      for (const anchor of plan.anchors) {
        const anchorHandle = this.hostFsWatch.watch(anchor.watchedPath, {
          recursive: false,
          ignored: anchor.candidatePath === undefined ? undefined : anchorIgnored(anchor),
        });
        handles.push(anchorHandle);
        anchorHandle.onDidChange(() => this.onAnchorChange(candidate, entry));
      }
      if (handles.length === 0) throw new Error(`No watch target for candidate: ${candidate}`);
      return entry;
    } catch (error) {
      for (const handle of handles) handle.dispose();
      throw error;
    }
  }

  private onTargetChange(candidate: string, expected: WatchEntry, change: HostFsChange): void {
    const entry = this.entries.get(candidate);
    if (entry !== expected || this.disposed || entry.plan.kind !== 'target') return;
    this.schedule();
    if (change.action === 'deleted' && normalizePath(change.path) === entry.plan.targetPath) {
      void this.enqueue(() => this.rebind(candidate));
    }
  }

  private onAnchorChange(candidate: string, expected: WatchEntry): void {
    const entry = this.entries.get(candidate);
    if (entry !== expected || this.disposed) return;
    if (entry.plan.kind === 'target') this.schedule();
    void this.enqueue(() => this.rebind(candidate));
  }

  private schedule(): void {
    this.debounce.cancelAndSet(() => {
      this.onChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private async existingDirRealpath(candidate: string): Promise<string | undefined> {
    try {
      if (!(await this.hostFs.stat(candidate)).isDirectory) return undefined;
      return normalizePath(await this.hostFs.realpath(candidate));
    } catch {
      return undefined;
    }
  }

  private async nearestExistingDirRealpath(candidate: string): Promise<string | undefined> {
    return (await this.nearestExistingDir(candidate))?.realPath;
  }

  private async nearestExistingDir(candidate: string): Promise<ExistingDir | undefined> {
    let current = normalizePath(candidate);
    while (true) {
      try {
        if ((await this.hostFs.stat(current)).isDirectory) {
          return {
            lexicalPath: current,
            realPath: normalizePath(await this.hostFs.realpath(current)),
          };
        }
      } catch {
      }
      const parent = normalizePath(dirname(current));
      if (parent === current) return undefined;
      current = parent;
    }
  }

  private async resolvePlan(candidate: string, previous?: WatchPlan): Promise<WatchPlan | undefined> {
    const target = await this.existingDirRealpath(candidate);
    if (target !== undefined) {
      return {
        kind: 'target',
        targetPath: target,
        anchors: await this.symlinkAnchors(candidate, target),
      };
    }
    const anchors = new Map<string, WatchAnchor>();
    for (const anchor of previous?.anchors ?? []) {
      if (anchor.candidatePath === undefined) anchors.set(anchor.watchedPath, anchor);
    }
    const previousTarget = previous?.kind === 'target' ? previous.targetPath : undefined;
    if (previousTarget !== undefined) {
      const watchedPath = await this.nearestExistingDirRealpath(previousTarget);
      if (watchedPath !== undefined) anchors.set(watchedPath, { watchedPath });
    }
    const lexical = await this.lexicalAnchor(candidate, true);
    if (lexical !== undefined) anchors.set(lexical.watchedPath, lexical);
    return anchors.size === 0 ? undefined : { kind: 'anchor', anchors: [...anchors.values()] };
  }

  private async symlinkAnchors(candidate: string, target: string): Promise<readonly WatchAnchor[]> {
    try {
      const lexical = normalizePath(candidate);
      const canonical = normalizePath(target);
      if (lexical === canonical && !(await this.hostFs.lstat(candidate)).isSymbolicLink) return [];
      const anchor = await this.lexicalAnchor(candidate, false);
      return anchor === undefined ? [] : [anchor];
    } catch {
      return [];
    }
  }

  private async lexicalAnchor(
    candidate: string,
    includeCandidate: boolean,
  ): Promise<WatchAnchor | undefined> {
    const anchor = await this.nearestExistingDir(includeCandidate ? candidate : dirname(candidate));
    if (anchor === undefined) return undefined;
    const nextSegment = relative(anchor.lexicalPath, candidate).split('/')[0];
    if (nextSegment === undefined || nextSegment === '') return undefined;
    return {
      watchedPath: anchor.realPath,
      candidatePath: normalizePath(join(anchor.realPath, nextSegment)),
    };
  }
}

function skillTreeIgnored(root: string): (path: string) => boolean {
  return (path) => {
    const rel = relative(root, normalizePath(path));
    if (rel === '' || rel.startsWith('..')) return false;
    return rel.split('/').some((segment) => !isSkillTraversalDirectory(segment));
  };
}

function anchorIgnored(anchor: WatchAnchor): (path: string) => boolean {
  return (path) => {
    const normalized = normalizePath(path);
    return normalized !== anchor.watchedPath && normalized !== anchor.candidatePath;
  };
}

function samePlan(left: WatchPlan, right: WatchPlan): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'anchor' && right.kind === 'anchor') {
    return sameAnchors(left.anchors, right.anchors);
  }
  if (left.kind !== 'target' || right.kind !== 'target') return false;
  return (
    left.targetPath === right.targetPath &&
    sameAnchors(left.anchors, right.anchors)
  );
}

function anchorKey(anchor: WatchAnchor): string {
  return `${anchor.watchedPath}\0${anchor.candidatePath ?? ''}`;
}

function sameAnchors(left: readonly WatchAnchor[], right: readonly WatchAnchor[]): boolean {
  return (
    left.length === right.length &&
    left.every((anchor, index) => anchorKey(anchor) === anchorKey(right[index]!))
  );
}

function disposeEntry(entry: WatchEntry): void {
  for (const handle of entry.handles) handle.dispose();
}

function normalizePath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}
