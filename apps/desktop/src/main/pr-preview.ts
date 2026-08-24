// PR preview (dev-only): load the renderer build of a code-app pull request
// into the running window.
//
// Flow: fetch `refs/pull/<n>/head` from the canonical repo (into FETCH_HEAD
// only — no refs accumulate in the developer's own checkout), materialize it
// in THE one preview worktree per running instance under
// `<userData>/pr-previews/preview-<clone hash>-<pid>` (the user's checkout is
// never touched, and previewing another PR reuses the same worktree via
// reset --hard — node_modules cache included — so disk stays bounded to one
// copy per live instance), then `pnpm install --ignore-scripts` +
// `pnpm --filter kimi-code-app run build:renderer` inside the worktree. On
// success the dist-root override in connect.ts is pointed at the freshly
// built dist dir; the ipc layer then re-runs connect() so the window reloads
// from `app://renderer` (which now serves the preview build) instead of the
// Vite dev server. The embedded server is not involved — only the renderer
// bundle swaps. stopPreview() drops the override and the same connect() pass
// returns the window to normal dev.
//
// Isolation is BY CONSTRUCTION, not by locking: the worktree path is bucketed
// per clone AND per process, so two dev instances never share mutable state
// and no cross-process lock (or lock protocol) is needed at all. Cleanup is
// layered: dead instances' copies are swept on boot and before each build
// (kill(pid, 0) probe), and the dialog offers a manual cache reclaim for
// everything but the served/in-flight dirs.
//
// Failure rule: a failed fetch/install/build must NOT strand a working
// preview. Two alternating dist dirs (`desktop-dist` / `desktop-dist.next`)
// make the build target always the NOT-currently-served one — Vite's
// emptyOutDir wipes only the staging dir and the override flips only after a
// successful build, so a failed rebuild leaves the previous preview serving
// with its files intact. The state goes `error` with the failing stage's
// output tail for the dialog; retry is just another startPreview().
//
// Everything errors out in packaged builds (startPreview throws); the
// renderer hides the entry point there by probing the bridge. State changes
// are pushed through injected listeners (ipc.ts forwards them over
// `kimi:pr-preview-event`) so this module never imports window.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { setPreviewDistRoot } from './connect';
import { startShellEnvProbe } from './shell-env';
import { log } from './log';

export type PrPreviewPhase = 'idle' | 'fetching' | 'installing' | 'building' | 'active' | 'error';

export interface PrPreviewState {
  phase: PrPreviewPhase;
  /** PR number of the current/last operation (busy, active, error). */
  pr?: number;
  /** Failure summary: stage name + the child output tail (last ~200 lines). */
  message?: string;
  /** Live output tail of the in-flight stage (throttled pushes), so the
      dialog can show what git/pnpm/vite is doing right now. Git runs with
      `--progress` — without it a piped fetch prints nothing for the whole
      download, which reads as "hung". */
  logTail?: string;
  /** PR whose build the window is actually serving right now, independent of
      the display phase: stays set through a failed rebuild (the previous
      preview keeps serving) and across busy phases; cleared only by an
      explicit stop. The native exit entry and the dialog's error-state exit
      button key off THIS, never off `phase`. */
  servingPr?: number;
  /** Stage a StageError came from, for the dialog's localized stage line. */
  errorStage?: Stage;
  /** The stage was killed by the no-output watchdog (not a plain failure). */
  errorHung?: boolean;
}

// The git steps (fetch / worktree / submodule) all report as 'fetching'.
type Stage = 'fetch' | 'install' | 'build';

// Cap of the per-stage output collection; the error message keeps the last
// ~200 lines of it (pnpm install can stream a lot on a cold store).
const OUTPUT_CAP = 256 * 1024;
const OUTPUT_TAIL_LINES = 200;

// Live progress: the tail pushed to the renderer is smaller (enough for a
// dialog log box), pushed at most every 250ms.
const PROGRESS_CAP = 16 * 1024;
const PROGRESS_PUSH_MS = 250;

// A stage that prints nothing for this long is treated as hung (dead proxy,
// stalled registry) and killed with an explicit error instead of spinning
// forever. pnpm/vite print regularly; git fetch prints with --progress.
const STALL_MS = 5 * 60 * 1000;

// SIGTERM escalation: a child that ignores it (stuck pnpm script) gets SIGKILL
// this many ms later.
const KILL_ESCALATION_MS = 3_000;

let state: PrPreviewState = { phase: 'idle' };
// What the window is actually serving from (mirrored into connect.ts via
// setPreviewDistRoot). Kept separate from `state` so an `error` phase never
// loses track of the still-live preview. activeWorktree is the worktree that
// root belongs to; buildingWorktree is the in-flight build's target — both
// are keep-guards for cache cleanup.
let activeDistRoot: string | null = null;
let activePr: number | undefined;
let activeWorktree: string | null = null;
let buildingWorktree: string | null = null;

let running = false;
let cancelRequested = false;
let currentChild: ChildProcess | null = null;
let killEscalation: ReturnType<typeof setTimeout> | null = null;

// Live progress tail of the in-flight run (see PrPreviewState.logTail).
let progressTail = '';
let progressPushTimer: ReturnType<typeof setTimeout> | null = null;

type StateListener = (state: PrPreviewState) => void;
const listeners = new Set<StateListener>();

/** Subscribe to state transitions (ipc.ts forwards them to the renderer). */
export function onStateChange(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: PrPreviewState): void {
  const withServing = activePr === undefined ? next : { ...next, servingPr: activePr };
  state = progressTail === '' ? withServing : { ...withServing, logTail: progressTail };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // A broken subscriber must not break the build flow.
    }
  }
}

/** Append child output to the live tail and schedule a throttled re-emit of
    the current state with it. \r becomes \n: git's progress meter redraws a
    single line with carriage returns, which a <pre> would render as one
    unreadable line. */
function noteProgress(chunk: string): void {
  progressTail += chunk.replace(/\r/g, '\n');
  if (progressTail.length > PROGRESS_CAP) progressTail = progressTail.slice(-PROGRESS_CAP);
  if (progressPushTimer === null) {
    progressPushTimer = setTimeout(() => {
      progressPushTimer = null;
      // A late push after settle is harmless (the final state was already
      // pushed), but skip it once the run is over so a post-mortem push can't
      // resurrect a stale tail into an idle/active state.
      if (running) setState({ ...state });
    }, PROGRESS_PUSH_MS);
    progressPushTimer.unref?.();
  }
}

export function getState(): PrPreviewState {
  return { ...state };
}

export function getActiveDistRoot(): string | null {
  return activeDistRoot;
}

/** Marker rejection for user-cancelled builds: NOT an error — the state was
    already set by cancelPreview()/stopPreview() and must not be overwritten. */
class PreviewCancelled extends Error {}

/** A stage that failed on its own (non-zero exit, spawn failure, stall kill).
    The message is DATA for the raw log box (command + exit reason + output
    tail), never English prose — the dialog renders the localized stage line
    from `stage`/`hung` instead. */
class StageError extends Error {
  constructor(
    message: string,
    readonly stage: Stage,
    readonly hung = false,
  ) {
    super(message);
  }
}

/** Resolves once the in-flight run (if any) has fully settled — children
    reaped, finally executed, `running` cleared. The cancel/stop IPC handlers
    await this so an immediate retry can't hit 'already in flight'. */
let settleNotify: (() => void) | null = null;
export function whenBuildSettled(): Promise<void> {
  if (!running) return Promise.resolve();
  return new Promise((resolve) => {
    const previous = settleNotify;
    settleNotify = () => {
      previous?.();
      resolve();
    };
  });
}

function pnpmCommand(): string {
  // Bare 'pnpm' everywhere: POSIX resolves it via PATH; Windows goes through
  // the explicit cmd.exe wrapper in runStage (PATHEXT finds pnpm.cmd).
  return 'pnpm';
}

/** Canonical repo the PR numbers refer to — fetch by URL, not by the `origin`
    remote name: a developer running the app from their fork would otherwise
    resolve refs/pull/<n>/head against the fork (wrong PR, or none at all).
    Credentials still go through the usual github.com credential helper. */
const CANONICAL_REPO = 'https://github.com/MoonshotAI/kimi-code-app.git';

function cloneBucket(repoDir: string): string {
  return createHash('sha256').update(repoDir).digest('hex').slice(0, 8);
}

/** Per-INSTANCE worktree path — deliberately PR-agnostic: there is exactly
    ONE preview worktree per running instance. Previewing another PR reuses
    it (reset --hard to the new ref, node_modules cache included), so disk
    stays bounded to one copy per live instance with zero cleanup machinery;
    the pid bucket keeps two dev instances from ever sharing mutable state
    (no lock anywhere), and the boot sweep removes dead instances' copies. */
function worktreeDirFor(repoDir: string): string {
  return join(app.getPath('userData'), 'pr-previews', `preview-${cloneBucket(repoDir)}-${process.pid}`);
}

/** Remove preview worktrees (ANY PR of this clone bucket) and legacy
    pre-pid layouts, keeping every dir in <keepDirs>. A pid-tagged dir goes
    only when its owner process is gone (kill(pid, 0) probe) — or, with
    includeOwn, when the owner is this process itself but the dir is not
    kept (the manual "reclaim disk now" case). Legacy dirs without a pid
    token go unconditionally — without the cross-PR sweep, previewing a
    series of PRs would leak a full checkout + node_modules per PR in
    userData forever. Dangling git worktree registrations are cleared by the
    prune in ensureWorktree. Best-effort: leftovers are disk, not
    correctness. Returns the number of removed entries. */
function sweepPreviewDirs(repoDir: string, keepDirs: ReadonlySet<string>, includeOwn: boolean): number {
  let entries: string[];
  const previewsRoot = join(app.getPath('userData'), 'pr-previews');
  try {
    entries = readdirSync(previewsRoot);
  } catch {
    return 0;
  }
  const bucket = cloneBucket(repoDir);
  let removed = 0;
  for (const entry of entries) {
    if (keepDirs.has(join(previewsRoot, entry))) continue;
    // Legacy lock files from the removed build-lock scheme ride along.
    const name = entry.endsWith('.build.lock') ? entry.slice(0, -'.build.lock'.length) : entry;
    // Current layout: preview-<bucket>-<pid>. Everything else that matches a
    // previous scheme is pre-release legacy and goes unconditionally (only
    // same-bucket entries are ever considered ours).
    let pidToken: string | undefined;
    const current = /^preview-([0-9a-f]{8})-(\d+)$/.exec(name);
    if (current !== null) {
      if (current[1] !== bucket) continue; // Another clone's copy.
      pidToken = current[2];
    } else {
      const legacy = /^(\d+)(?:-([0-9a-f]{8})(?:-(\d+))?)?$/.exec(name);
      if (legacy === null) continue;
      if (legacy[2] !== undefined && legacy[2] !== bucket) continue;
      pidToken = legacy[3];
    }
    if (pidToken !== undefined) {
      const ownerPid = Number(pidToken);
      if (ownerPid === process.pid) {
        if (!includeOwn) continue;
      } else {
        try {
          process.kill(ownerPid, 0);
          continue; // Live instance.
        } catch {
          // Dead — sweep below.
        }
      }
    }
    try {
      rmSync(join(previewsRoot, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Keep sweeping the rest.
    }
  }
  return removed;
}

/** Boot-time hygiene (app.ts, fire-and-forget): remove everything a previous
    run left behind — dead-pid worktrees of every PR in this clone bucket and
    legacy layouts. Keeps any OTHER live instance's dirs via the pid probe. */
export function sweepStalePreviews(): void {
  if (app.isPackaged) return;
  const removed = sweepPreviewDirs(app.getAppPath(), new Set(), false);
  if (removed > 0) log.info(`[kimi-desktop] swept ${removed} stale PR preview dir(s) on boot`);
}

/** Manual cache reclaim (the dialog's cleanup button): remove every preview
    dir of this clone bucket except the one currently serving and the one an
    in-flight build is writing into. Own-pid dirs from earlier previews in
    THIS run go too (they're cache, rebuildable at any time). */
export function cleanupPreviews(): number {
  if (app.isPackaged) return 0;
  const keep = new Set<string>();
  if (activeWorktree !== null) keep.add(activeWorktree);
  if (buildingWorktree !== null) keep.add(buildingWorktree);
  const removed = sweepPreviewDirs(app.getAppPath(), keep, true);
  if (removed > 0) log.info(`[kimi-desktop] cleaned ${removed} PR preview dir(s) on request`);
  return removed;
}

function tailLines(output: string): string {
  const lines = output.split('\n');
  return lines.length <= OUTPUT_TAIL_LINES ? output : lines.slice(-OUTPUT_TAIL_LINES).join('\n');
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no POSIX signals or negative-pid group kills: taskkill /T
    // takes down the whole tree — the pnpm shim's Node/vite/install-script
    // grandchildren included, which a bare child.kill() would leave running.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } catch {
      // Already gone.
    }
    return;
  }
  // POSIX children spawn detached (process-group leaders) so pnpm/vite
  // grandchildren die with the leader.
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Group already gone — fall through to the direct kill.
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** SIGTERM the in-flight stage child, with a SIGKILL escalation. */
function killCurrentChild(): void {
  const child = currentChild;
  if (child === null) return;
  signalChild(child, 'SIGTERM');
  if (killEscalation !== null) clearTimeout(killEscalation);
  killEscalation = setTimeout(() => {
    killEscalation = null;
    signalChild(child, 'SIGKILL');
  }, KILL_ESCALATION_MS);
  killEscalation.unref?.();
}

/** before-quit sweep (app.ts): SIGKILL the in-flight build, no state churn. */
export function killActiveBuild(): void {
  const child = currentChild;
  if (child !== null) signalChild(child, 'SIGKILL');
}

/**
 * Run one build stage, resolving with the (capped) child output. Rejects with
 * StageError on non-zero exit / spawn failure, PreviewCancelled when the user
 * cancelled. The child is tracked module-level so cancel/stop/quit can kill it.
 */
function runStage(stage: Stage, command: string, args: string[], cwd: string): Promise<string> {
  if (cancelRequested) return Promise.reject(new PreviewCancelled());
  return new Promise<string>((resolve, reject) => {
    // Windows can't CreateProcess a .cmd shim directly, and shell:true with
    // an args array is DEP0190 territory (Node concatenates without escaping
    // — userData paths contain spaces, so --outDir would split). Go through
    // cmd.exe explicitly instead: with shell:false, libuv quotes each
    // argument properly. taskkill /T still covers the whole process tree.
    const isWin = process.platform === 'win32';
    const exe = isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : command;
    const exeArgs = isWin ? ['/d', '/s', '/c', command, ...args] : args;
    const child = spawn(exe, exeArgs, {
      cwd,
      // Inherit the probe-merged env (PATH must find git/pnpm on GUI launches).
      // CI=1 buys line-based output (no spinner redraws) from pnpm & friends.
      env: { ...process.env, CI: '1' },
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentChild = child;
    let out = '';
    // Stall watchdog: re-armed on every chunk of child output; firing means
    // the stage produced nothing for STALL_MS (dead proxy, stuck registry) —
    // kill it and report a hang instead of spinning forever.
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        signalChild(child, 'SIGKILL');
      }, STALL_MS);
      stallTimer.unref?.();
    };
    armStall();
    const append = (chunk: string): void => {
      out += chunk;
      if (out.length > OUTPUT_CAP) out = out.slice(out.length - OUTPUT_CAP);
      armStall();
      noteProgress(chunk);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (killEscalation !== null) {
        clearTimeout(killEscalation);
        killEscalation = null;
      }
      if (currentChild === child) currentChild = null;
      fn();
    };
    child.on('error', (error) => {
      settle(() => reject(new StageError(`${command} spawn failed: ${error.message}`, stage)));
    });
    child.on('close', (code, signal) => {
      if (cancelRequested) {
        settle(() => reject(new PreviewCancelled()));
      } else if (stalled) {
        const tail = tailLines(out).trim();
        settle(() =>
          reject(
            new StageError(
              `no output for ${Math.round(STALL_MS / 60000)} min before kill` + (tail === '' ? '' : `\n${tail}`),
              stage,
              true,
            ),
          ),
        );
      } else if (code === 0) {
        settle(() => resolve(out));
      } else {
        const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
        const tail = tailLines(out).trim();
        settle(() =>
          reject(
            new StageError(
              `${command} ${args.join(' ')} (${how})` + (tail === '' ? '' : `\n${tail}`),
              stage,
            ),
          ),
        );
      }
    });
  });
}

async function ensureWorktree(repoDir: string, worktreeDir: string, headSha: string): Promise<void> {
  // Stale registrations (preview dirs deleted by the sweep or by hand) make
  // `worktree add` refuse the path — prune first, always.
  await runStage('fetch', 'git', ['-C', repoDir, 'worktree', 'prune'], repoDir);
  if (existsSync(worktreeDir)) {
    // The single per-instance worktree is only ever this instance's own
    // previous build — plain reuse. Reset hard to the newly fetched head:
    // the old PR's (or an interrupted run's) dirty tracked files must not
    // leak into this build (untracked dirs like node_modules stay, keeping
    // the install cache across PR switches). A dir too broken to reset (git
    // locks, corrupt index) gets recreated.
    try {
      await runStage('fetch', 'git', ['-C', worktreeDir, 'reset', '--hard', headSha], worktreeDir);
    } catch (error) {
      if (error instanceof PreviewCancelled) throw error;
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
  if (!existsSync(worktreeDir)) {
    await runStage('fetch', 'git', ['-C', repoDir, 'worktree', 'add', '--detach', worktreeDir, headSha], repoDir);
  }
  // The pnpm workspace spans kimi-code/packages/* — install fails without the
  // submodule even though the renderer bundle itself never imports it. Borrow
  // objects from the developer's existing submodule clone when present.
  const commonDir = (
    await runStage('fetch', 'git', ['-C', repoDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], repoDir)
  ).trim();
  const referenceDir = join(commonDir, 'modules', 'kimi-code');
  const args = ['-C', worktreeDir, 'submodule', 'update', '--init'];
  if (existsSync(referenceDir)) args.push('--reference', referenceDir);
  args.push('kimi-code');
  await runStage('fetch', 'git', args, worktreeDir);
}

/**
 * Fetch PR <pr>, build its renderer in an isolated worktree, and activate the
 * preview. Resolves with the resulting state ('active' or 'error' — build
 * failures are reported in the state, not thrown). Throws only for
 * precondition violations: packaged build, or a build already in flight.
 */
export async function startPreview(pr: number): Promise<PrPreviewState> {
  if (app.isPackaged) {
    throw new Error('pr-preview: only available in dev (unpackaged) builds');
  }
  if (running) {
    throw new Error('pr-preview: a preview build is already in flight');
  }
  running = true;
  cancelRequested = false;
  progressTail = '';
  // Every state transition below is guarded by this: a cancel/stop that
  // landed during the PREVIOUS await (e.g. the shell-env probe, which spawns
  // no killable child) must not be overwritten by the next phase publish —
  // otherwise the UI ends up stuck on a busy phase with no process behind it.
  const throwIfCancelled = (): void => {
    if (cancelRequested) throw new PreviewCancelled();
  };
  // For the log line in catch: which stage the run died in.
  let currentStage: Stage = 'fetch';
  const repoDir = app.getAppPath();
  const worktreeDir = worktreeDirFor(repoDir);
  try {
    // Wait out the memoized shell-env probe so the children inherit the user's
    // PATH (GUI launches get launchd's minimal env).
    await startShellEnvProbe();
    throwIfCancelled();
    setState({ phase: 'fetching', pr });
    // Fetch by URL (CANONICAL_REPO), never by the origin remote — see the
    // constant's comment. --progress: a piped fetch is otherwise silent for
    // the entire download. --no-tags: git's default tag-following would
    // otherwise write the repo's tags into the developer's own checkout
    // (and fail the whole fetch on a clobbering local tag). No destination
    // ref: the head lands in FETCH_HEAD only, so refs/pr-preview/* never
    // accumulate in the developer's own repo either.
    await runStage('fetch', 'git', ['-C', repoDir, 'fetch', '--progress', '--no-tags', CANONICAL_REPO, `refs/pull/${pr}/head`], repoDir);
    const headSha = (
      await runStage('fetch', 'git', ['-C', repoDir, 'rev-parse', 'FETCH_HEAD'], repoDir)
    ).trim();
    sweepPreviewDirs(repoDir, new Set([worktreeDir]), false);
    buildingWorktree = worktreeDir;
    await ensureWorktree(repoDir, worktreeDir, headSha);
    throwIfCancelled();
    currentStage = 'install';
    setState({ phase: 'installing', pr });
    // --ignore-scripts: an arbitrary remote PR must not get to run its
    // install-time lifecycle scripts (the classic supply-chain vector) under
    // the developer's full user account. Fonts are still prepared by the
    // build's own prebuild:renderer hook; node-pty's rebuild is irrelevant
    // to a renderer-only build.
    await runStage('install', pnpmCommand(), ['install', '--prefer-offline', '--ignore-scripts'], worktreeDir);
    throwIfCancelled();
    currentStage = 'build';
    setState({ phase: 'building', pr });
    // Two alternating dist dirs: the build always targets the one NOT being
    // served by this process, and the override flips only after a successful
    // build. Vite's emptyOutDir therefore never wipes the live preview out
    // from under the protocol handler (a failed rebuild keeps the previous
    // build serving, files and all — and no rename dance means no Windows
    // file-lock edge).
    const desktopDir = join(worktreeDir, 'apps', 'desktop');
    const distA = join(desktopDir, 'desktop-dist');
    const distB = join(desktopDir, 'desktop-dist.next');
    const stagingDist = activeDistRoot === distA ? distB : distA;
    await runStage('build', pnpmCommand(), ['--filter', 'kimi-code-app', 'run', 'build:renderer', '--', '--outDir', stagingDist], worktreeDir);
    throwIfCancelled();
    activeDistRoot = stagingDist;
    activePr = pr;
    activeWorktree = worktreeDir;
    setPreviewDistRoot(activeDistRoot);
    setState({ phase: 'active', pr });
    log.info(`[kimi-desktop] PR preview active for #${pr}: ${activeDistRoot}`);
  } catch (error) {
    // A killed run (cancel / stop / stall watchdog) can leave the font
    // preparation lock behind — a signal-terminated prepare-fonts.mjs never
    // runs its finally, and the next retry would wait LOCK_WAIT_MS (2 min) on
    // a dead lock (stale only after 10 min). Best-effort cleanup: a failed
    // removal (EPERM, busy fs) must not swallow the original stage error.
    try {
      rmSync(join(worktreeDir, 'packages', 'app-ui', 'src', 'assets', 'fonts', '.font-preparation.lock'), {
        recursive: true,
        force: true,
      });
    } catch {
      // See above — best-effort by contract.
    }
    if (!(error instanceof PreviewCancelled)) {
      // The previous override (if any) stays live — see the header comment.
      const message = error instanceof Error ? error.message : String(error);
      log.error(`[kimi-desktop] PR preview #${pr} failed at ${currentStage}: ${message}`);
      if (error instanceof StageError) {
        setState({
          phase: 'error',
          pr,
          errorStage: error.stage,
          ...(error.hung ? { errorHung: true } : {}),
          message,
        });
      } else {
        setState({ phase: 'error', pr, message });
      }
    }
  } finally {
    running = false;
    buildingWorktree = null;
    settleNotify?.();
    settleNotify = null;
  }
  return getState();
}

/** Exit the preview: drop the dist-root override and go idle. The ipc layer
    re-runs connect() afterwards to load the normal dev renderer. Also kills
    an in-flight build (a stopped preview must not activate on settle). */
export function stopPreview(): void {
  if (running) {
    cancelRequested = true;
    killCurrentChild();
  }
  activeDistRoot = null;
  activePr = undefined;
  activeWorktree = null;
  progressTail = '';
  setPreviewDistRoot(null);
  setState({ phase: 'idle' });
}

/** Cancel the in-flight build. Returns to the pre-build reality: with a live
    override the preview stays `active` (the window is still serving it);
    without one, idle. */
export function cancelPreview(): void {
  if (!running) return;
  cancelRequested = true;
  killCurrentChild();
  progressTail = '';
  setState(activeDistRoot !== null ? { phase: 'active', pr: activePr } : { phase: 'idle' });
}
