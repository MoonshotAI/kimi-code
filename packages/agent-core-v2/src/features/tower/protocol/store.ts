import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { listBaseDirtyEntries, snapshotBaseWip } from './baseWip';
import { parseFrontmatter, renderFrontmatter } from './frontmatter';
import {
  branchExists,
  branchTip,
  checkoutNewLocalBranch,
  commitAllowEmpty,
  commitPaths,
  currentBranch,
  diffNameOnly,
  git,
  GitError,
  hasAnyCommit,
  initRepository,
  isAncestor,
  isInsideRepo,
  isRegisteredWorktree,
  isWorktreeDirty,
  mergeNoFf,
  tryGit,
  worktreeAdd,
  worktreeAddNewBranch,
  worktreeRemove,
} from './git';
import { evaluateMissionGate } from './missionGate';
import type { TowerMissionGateResult, TowerMissionGitObservations } from './missionGate';
import {
  ACTIVITY_LOG,
  BROADCAST_NAME,
  FINDINGS_DIR,
  INBOX_DIR,
  LOG_DIR,
  MISSIONS_DIR,
  MISSIONS_INDEX,
  REVIEWS_DIR,
  STATE_FILE,
  TOWER_NAME,
  TOWER_ROOT,
  WORKTREES_DIR,
  isReservedTowerAgentName,
  dateDash,
  findingFileName,
  hasNonAsciiCharacters,
  inboxFileName,
  missionFileName,
  reviewFileName,
  slugify,
  targetSlug,
} from './paths';
import type {
  TowerFindingSeverity,
  TowerFindingType,
  TowerInboxItem,
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
} from './types';

export class TowerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowerProtocolError';
  }
}

export const MAX_REVIEW_ROUNDS = 5;

export type TowerReanchorRelation = 'no-branch' | 'up-to-date' | 'stale';

export interface TowerReanchorMissionDigest {
  readonly id: string;
  readonly branch: string;
  readonly relation: TowerReanchorRelation;
  readonly branchTip?: string;
}

export interface TowerReanchorDigest {
  readonly from: string;
  readonly to: string;
  readonly baseTip: string;
  readonly missions: readonly TowerReanchorMissionDigest[];
}

export interface TowerInitResult {
  readonly base: string;
  readonly created: boolean;
  readonly retiredAgents: readonly string[];
  readonly checkout: string;
  readonly rebasedFrom?: string;
  readonly rebaseDigest?: TowerReanchorDigest;
  readonly openMissions: readonly string[];
}

export interface TowerPlanInput {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tasks?: readonly string[];
  readonly context?: string;
  readonly deps?: readonly string[];
  readonly kind?: TowerMissionKind;
}

export interface TowerSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
}

export interface TowerSendResult {
  readonly item: TowerInboxItem;
  readonly missionId?: string;
  readonly activityLogError?: string;
}

export interface TowerCompleteResult {
  readonly mission?: TowerMission;
  readonly recoveredAt?: string;
  readonly message?: TowerSendResult;
  readonly notificationCreated: boolean;
  readonly notificationError?: string;
  readonly activityLogError?: string;
}

export interface TowerFindingInput {
  readonly type: TowerFindingType;
  readonly title: string;
  readonly severity?: TowerFindingSeverity;
  readonly summary: string;
  readonly location?: string;
  readonly details: string;
  readonly suggestedFix: string;
}

export interface TowerReviewInput {
  readonly target: string;
  readonly status: string;
  readonly merge: string;
  readonly findings: string;
  readonly checks?: readonly string[];
  readonly decision: string;
}

export interface TowerReviewResult {
  readonly review: TowerReviewInfo;
  readonly storedMessages: readonly TowerSendResult[];
  readonly notificationError?: string;
  readonly activityLogError?: string;
}

export interface TowerMissionPatch {
  readonly status?: TowerMissionStatus;
  readonly note?: string;
  readonly blocker?: string;
  readonly clearBlockers?: boolean;
  readonly taskDone?: string;
  readonly taskDrop?: { readonly text: string; readonly reason?: string };
  readonly owner?: string;
  readonly scope?: readonly string[];
  readonly spawnBase?: string;
}

export interface TowerAddWorktreeResult {
  readonly rel: string;
  readonly spawnBase?: string;
}

export interface TowerStoreOptions {
  readonly stateLockTimeoutMs?: number;
  readonly stateLockPollMs?: number;
}

export interface TowerMissionRuntimeOptions {
  readonly activeAgentIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

export interface TowerMergeResult {
  readonly status: 'merged' | 'advanced' | 'noop';
  readonly mergeCommit: string;
  readonly evaluatedBranchTip: string;
  readonly currentBranchTip: string;
  readonly conflictsWith: ReadonlyArray<{
    readonly branch: string;
    readonly files: readonly string[];
  }>;
  readonly noop?: boolean;
}

export interface TowerRebaseMissionResult {
  readonly status: 'up-to-date' | 'rebased' | 'conflict';
  readonly fromCommit?: string;
  readonly toCommit?: string;
  readonly files?: readonly string[];
}

export interface TowerTeardownOptions {
  readonly force?: boolean;
  readonly exclude?: readonly string[];
  readonly dryRun?: boolean;
  readonly liveAgentIds?: ReadonlySet<string>;
}

const FINDING_TYPES: readonly TowerFindingType[] = ['bug', 'improve', 'vuln', 'idea'];
const STATUS_EMOJI: Record<TowerMissionStatus, string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

function isOpenMission(mission: Pick<TowerMission, 'status'>): boolean {
  return mission.status !== 'merged' && mission.status !== 'abandoned';
}

function missionNumber(id: string): number {
  const n = Number.parseInt(id.replace(/^M/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

function scopeStem(raw: string): string {
  return raw.replace(/\/\*\*?$/, '').replace(/\/+$/, '').replace(/\*+$/, '');
}

export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const rawA of a) {
    const stemA = scopeStem(rawA);
    if (stemA.length === 0) continue;
    for (const rawB of b) {
      const stemB = scopeStem(rawB);
      if (stemB.length === 0) continue;
      if (stemA === stemB || stemA.startsWith(`${stemB}/`) || stemB.startsWith(`${stemA}/`)) {
        return true;
      }
    }
  }
  return false;
}

function depPathExists(fromId: string, toId: string, byId: ReadonlyMap<string, TowerMission>): boolean {
  const seen = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const mission = byId.get(current);
    if (mission === undefined || !isOpenMission(mission)) continue;
    for (const dep of mission.deps) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return false;
}

function autoDepNote(mission: TowerMission, other: TowerMission): string {
  return `auto dependency on ${other.id}: scope overlaps ${other.id} ("${other.scope.join(', ')}") — merges are serialized so shared files land in dependency order instead of colliding`;
}

function addAutoDeps(
  mission: TowerMission,
  candidates: readonly TowerMission[],
  byId: ReadonlyMap<string, TowerMission>,
): void {
  if (mission.kind === 'survey') return;
  for (const other of candidates) {
    if (other.id === mission.id || other.kind === 'survey') continue;
    if (!scopesOverlap(mission.scope, other.scope)) continue;
    if (depPathExists(mission.id, other.id, byId) || depPathExists(other.id, mission.id, byId)) {
      continue;
    }
    mission.deps.push(other.id);
    mission.notes.push(autoDepNote(mission, other));
  }
}

export function resolveMissionByBranch(
  state: TowerState,
  branch: string,
): TowerMission | undefined {
  let resolved: TowerMission | undefined;
  for (const mission of state.missions) {
    if (mission.branch !== branch || !isOpenMission(mission)) continue;
    if (resolved === undefined || missionNumber(mission.id) > missionNumber(resolved.id)) {
      resolved = mission;
    }
  }
  return resolved;
}

function unownedBranchMessage(branch: string): string {
  return `branch "${branch}" exists in git but is not owned by any tower mission (it appeared after planning) — refusing to build the worker on unrelated history; delete or rename that branch if it is stale, or re-plan the mission under a new title`;
}

export async function assertLocalBaseBranch(repoRoot: string, base: string): Promise<void> {
  if (!(await branchExists(repoRoot, base))) {
    throw new TowerProtocolError(
      `base branch "${base}" does not exist as a local branch — merges land on a local branch, so remote-tracking refs and tags are not accepted; create a local branch first`,
    );
  }
}

export class TowerStore {
  private readonly stateLockTimeoutMs: number;
  private readonly stateLockPollMs: number;

  constructor(
    readonly repoRoot: string,
    options: TowerStoreOptions = {},
  ) {
    this.stateLockTimeoutMs = options.stateLockTimeoutMs ?? 10_000;
    this.stateLockPollMs = options.stateLockPollMs ?? 10;
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.abs(STATE_FILE)}.lock`;
    const deadline = Date.now() + this.stateLockTimeoutMs;
    const token = randomUUID();
    while (!(await this.tryAcquireStateLock(lockPath, token))) {
      if (Date.now() >= deadline) {
        let holder = '';
        try {
          holder = ` — held by ${(await readFile(lockPath, 'utf8')).trim()}`;
        } catch {
        }
        throw new TowerProtocolError(
          `timed out after ${String(this.stateLockTimeoutMs)}ms waiting for the tower state lock "${lockPath}"${holder} — another tower process is writing state.json; if no tower process is alive, delete the stale lock file and retry`,
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.stateLockPollMs);
      });
    }
    try {
      return await fn();
    } finally {
      await this.releaseStateLock(lockPath, token);
    }
  }

  private async releaseStateLock(lockPath: string, token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(lockPath, 'utf8');
    } catch {
      return;
    }
    if (!content.includes(`token=${token}`)) return;
    await rm(lockPath, { force: true });
  }

  private async tryAcquireStateLock(lockPath: string, token: string): Promise<boolean> {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(
          `pid=${String(process.pid)} since=${new Date().toISOString()} token=${token}`,
          'utf8',
        );
        return true;
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === 'ENOENT') {
        throw await this.stateMissingError();
      }
      throw error;
    }
  }

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async isStateLost(): Promise<boolean> {
    if (await this.isInitialized()) return false;
    return existsSync(this.abs(TOWER_ROOT));
  }

  private async stateMissingError(): Promise<TowerProtocolError> {
    if (await this.isStateLost()) {
      return new TowerProtocolError(
        'tower state was lost: .tower/comms/state.json is missing but the .tower/ directory still exists — the tower was initialized here and its comms state was deleted (e.g. by git clean), so all recorded mission, roster, and review history is gone. This operation is refused instead of silently running against an empty history; TowerStatus reports the loss, and TowerSend/TowerComplete recover a minimal state (stamped recoveredAt) automatically',
      );
    }
    return new TowerProtocolError(
      'tower is not initialized in this repository — run TowerInit first',
    );
  }

  async ensureRepository(base?: string): Promise<void> {
    if (await isInsideRepo(this.repoRoot)) return;
    await initRepository(this.repoRoot);
    const unborn = (await tryGit(this.repoRoot, ['symbolic-ref', '--short', 'HEAD'])) ?? 'main';
    const resolvedBase = base ?? unborn;
    if (resolvedBase !== unborn) {
      await checkoutNewLocalBranch(this.repoRoot, resolvedBase);
    }
    const dirty = await listBaseDirtyEntries(this.repoRoot);
    if (dirty.length === 0) {
      await commitAllowEmpty(this.repoRoot, 'tower: init');
      return;
    }
    await commitPaths(
      this.repoRoot,
      dirty.map((entry) => entry.path),
      `tower: snapshot of uncommitted base checkout changes (base ${resolvedBase})`,
    );
  }

  async init(sessionId?: string, base?: string): Promise<TowerInitResult> {
    await this.ensureRepository(base);
    if (!(await hasAnyCommit(this.repoRoot))) {
      throw new TowerProtocolError(
        'the repository has no commits yet — create an initial commit first',
      );
    }
    await mkdir(dirname(this.abs(STATE_FILE)), { recursive: true });
    return this.withStateLock(async () => {
      if (await this.isInitialized()) {
        const loaded = await this.load();
        let rebasedFrom: string | undefined;
        let rebaseDigest: TowerReanchorDigest | undefined;
        let state = loaded;
        if (base !== undefined && base !== loaded.base) {
          const reanchor = await this.reanchorLocked(loaded, base);
          rebasedFrom = reanchor.digest.from;
          rebaseDigest = reanchor.digest;
          state = reanchor.state;
        }
        const retiredAgents = await this.adoptForeignRoster(state, sessionId);
        return {
          base: state.base,
          created: false,
          retiredAgents,
          checkout: await this.checkedOutBranch(),
          rebasedFrom,
          rebaseDigest,
          openMissions: state.missions.filter(isOpenMission).map((m) => m.id),
        };
      }

      const checkout = await this.checkedOutBranch();
      let resolvedBase: string;
      if (base !== undefined) {
        await assertLocalBaseBranch(this.repoRoot, base);
        resolvedBase = base;
      } else {
        if (checkout === 'HEAD') {
          throw new TowerProtocolError(
            'cannot determine the base branch from a detached HEAD — pass the base branch explicitly',
          );
        }
        resolvedBase = checkout;
      }

      for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
        await mkdir(this.abs(dir), { recursive: true });
      }
      await this.ensureGitExclude();

      const state: TowerState = {
        version: 1,
        base: resolvedBase,
        mode: 'branch',
        createdAt: new Date().toISOString(),
        sessionId,
        roster: { agents: [] },
        missions: [],
      };
      await this.save(state);
      await writeFile(this.abs(ACTIVITY_LOG), '', 'utf8');
      await this.renderMissionsIndex(state);
      await this.appendLog(TOWER_NAME, 'init', { mode: state.mode, base: resolvedBase }, MISSIONS_INDEX);
      return { base: resolvedBase, created: true, retiredAgents: [], checkout, openMissions: [] };
    });
  }

  private async reanchorLocked(
    state: TowerState,
    base: string,
  ): Promise<{ readonly digest: TowerReanchorDigest; readonly state: TowerState }> {
    await assertLocalBaseBranch(this.repoRoot, base);
    const baseTip = await branchTip(this.repoRoot, base);
    const open = state.missions.filter(isOpenMission);
    const missions: TowerReanchorMissionDigest[] = [];
    for (const mission of open) {
      if (!(await branchExists(this.repoRoot, mission.branch))) {
        missions.push({ id: mission.id, branch: mission.branch, relation: 'no-branch' });
        continue;
      }
      const branchTipForMission = await branchTip(this.repoRoot, mission.branch);
      missions.push({
        id: mission.id,
        branch: mission.branch,
        relation: (await isAncestor(this.repoRoot, baseTip, branchTipForMission))
          ? 'up-to-date'
          : 'stale',
        branchTip: branchTipForMission,
      });
    }
    const digest: TowerReanchorDigest = {
      from: state.base,
      to: base,
      baseTip,
      missions,
    };
    const next = { ...state, base };
    await this.save(next);
    await this.appendLog(TOWER_NAME, 'rebase', {
      from: digest.from,
      to: base,
      open_missions: open.length > 0 ? open.length : undefined,
      relations:
        missions.length > 0
          ? missions.map((mission) => `${mission.id}:${mission.relation}`).join(',')
          : undefined,
    });
    return { digest, state: next };
  }

  async rebase(base: string): Promise<TowerReanchorDigest | undefined> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (state.base === base) return undefined;
      return (await this.reanchorLocked(state, base)).digest;
    });
  }

  private async checkedOutBranch(): Promise<string> {
    return (await tryGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD';
  }

  private async adoptForeignRoster(
    state: TowerState,
    sessionId: string | undefined,
  ): Promise<readonly string[]> {
    if (sessionId === undefined || state.sessionId === sessionId) return [];
    const previous = state.sessionId;
    const stale = state.roster.agents.filter((agent) => agent.sessionId !== sessionId);
    state.roster.agents.splice(
      0,
      state.roster.agents.length,
      ...state.roster.agents.filter((agent) => agent.sessionId === sessionId),
    );
    state.sessionId = sessionId;
    await this.save(state);
    await this.appendLog(TOWER_NAME, 'adopt', {
      session: sessionId,
      previous: previous ?? 'unknown',
      retired: stale.length > 0 ? stale.map((agent) => agent.name).join(',') : undefined,
    });
    return stale.map((agent) => agent.name);
  }

  async adopt(sessionId: string): Promise<readonly string[]> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      return this.adoptForeignRoster(state, sessionId);
    });
  }

  async release(sessionId: string): Promise<void> {
    if (!(await this.isInitialized())) return;
    await this.withStateLock(async () => {
      const state = await this.load();
      if (state.sessionId !== sessionId) return;
      state.sessionId = undefined;
      await this.save(state);
      await this.appendLog(TOWER_NAME, 'release', { session: sessionId });
    });
  }

  private async ensureGitExclude(): Promise<void> {
    const gitDir = (await readGitDir(this.repoRoot)) ?? join(this.repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === '.tower/')) return;
    await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}.tower/\n`, 'utf8');
  }

  async load(): Promise<TowerState> {
    let raw: string;
    try {
      raw = await readFile(this.abs(STATE_FILE), 'utf8');
    } catch {
      throw await this.stateMissingError();
    }
    const state = JSON.parse(raw) as TowerState;
    for (const mission of state.missions) {
      mission.kind ??= 'build';
    }
    return state;
  }

  async loadOrRecover(): Promise<TowerState> {
    if (await this.isInitialized()) return this.load();
    if (!(await this.isStateLost())) {
      throw new TowerProtocolError(
        'tower is not initialized in this repository — run TowerInit first',
      );
    }
    return this.recoverMinimalState();
  }

  private async recoverMinimalState(): Promise<TowerState> {
    for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
      await mkdir(this.abs(dir), { recursive: true });
    }
    return this.withStateLock(async () => {
      if (await this.isInitialized()) return this.load();
      const checkout = await this.checkedOutBranch();
      if (checkout === 'HEAD') {
        throw new TowerProtocolError(
          'tower state was lost and the checkout is on a detached HEAD — the recovered minimal state takes the current checkout branch as its base, which a detached HEAD cannot provide; check out the previous base branch and retry, or run TowerInit with an explicit base',
        );
      }
      const now = new Date().toISOString();
      const state: TowerState = {
        version: 1,
        base: checkout,
        mode: 'branch',
        createdAt: now,
        recoveredAt: now,
        roster: { agents: [] },
        missions: [],
      };
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.appendLog(
        TOWER_NAME,
        'state.recovered',
        { base: checkout, recovered_at: now },
        MISSIONS_INDEX,
      );
      return state;
    });
  }

  async resolveMessagingCaller(
    state: TowerState,
    agentId: string,
  ): Promise<{ readonly caller: string; readonly state: TowerState; readonly placeholder?: boolean }> {
    if (agentId === 'main' || state.recoveredAt === undefined) {
      return { caller: this.resolveCallerName(state, agentId), state };
    }
    const entry = this.resolveAgent(state, agentId);
    if (entry !== undefined) return { caller: entry.name, state };
    await this.registerAgent({
      name: agentId,
      agentId,
      kind: 'worker',
      spawnedAt: state.recoveredAt,
    });
    await this.appendLog(TOWER_NAME, 'roster.placeholder', {
      agent: agentId,
      recovered_at: state.recoveredAt,
    });
    return { caller: agentId, state: await this.load(), placeholder: true };
  }

  private async save(state: TowerState): Promise<void> {
    const file = this.abs(STATE_FILE);
    const tmp = `${file}.tmp-${String(process.pid)}-${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async appendLog(
    actor: string,
    action: string,
    details: Readonly<Record<string, string | number | undefined>> = {},
    ref?: string,
  ): Promise<void> {
    const kv = Object.entries(details)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const parts = [new Date().toISOString(), actor, action];
    if (kv.length > 0) parts.push(kv);
    if (ref !== undefined) parts.push(`ref=${ref}`);
    await appendFile(this.abs(ACTIVITY_LOG), `${parts.join(' ')}\n`, 'utf8');
  }

  async recentLog(lines: number): Promise<readonly string[]> {
    let content = '';
    try {
      content = await readFile(this.abs(ACTIVITY_LOG), 'utf8');
    } catch {
      return [];
    }
    const all = content.split('\n').filter((line) => line.trim().length > 0);
    return all.slice(-lines);
  }

  resolveAgent(state: TowerState, agentId: string): TowerRosterEntry | undefined {
    let resolved: TowerRosterEntry | undefined;
    for (const agent of state.roster.agents) {
      if (agent.agentId === agentId) resolved = agent;
    }
    return resolved;
  }

  resolveCallerName(state: TowerState, agentId: string): string {
    if (agentId === 'main') return TOWER_NAME;
    const entry = this.resolveAgent(state, agentId);
    if (entry === undefined) {
      throw new TowerProtocolError(
        `agent "${agentId}" is not a tower participant — only spawned workers/reviewers and the tower can use tower tools`,
      );
    }
    return entry.name;
  }

  findAgent(state: TowerState, name: string): TowerRosterEntry | undefined {
    return state.roster.agents.find((agent) => agent.name === name);
  }

  findByName(state: TowerState, name: string): TowerRosterEntry | undefined {
    return this.findAgent(state, name);
  }

  async registerAgent(entry: TowerRosterEntry): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.load();
      if (entry.name.trim().length === 0 || entry.name.trim() !== entry.name) {
        throw new TowerProtocolError(
          `tower agent name "${entry.name}" must not be blank or carry surrounding whitespace`,
        );
      }
      if (isReservedTowerAgentName(entry.name)) {
        throw new TowerProtocolError(
          `tower agent name "${entry.name}" is reserved by the tower protocol — pick a different name`,
        );
      }
      for (let index = state.roster.agents.length - 1; index >= 0; index -= 1) {
        if (state.roster.agents[index]!.agentId === entry.agentId) {
          state.roster.agents.splice(index, 1);
        }
      }
      if (this.findAgent(state, entry.name) !== undefined) {
        throw new TowerProtocolError(`tower agent name "${entry.name}" is already registered`);
      }
      state.roster.agents.push({
        ...entry,
        lastInboxReadAt: entry.lastInboxReadAt ?? entry.spawnedAt,
      });
      await this.save(state);
    });
  }

  async markAgentDied(
    agentId: string,
    status: string,
    reason?: string,
    sessionId?: string,
  ): Promise<TowerRosterEntry | undefined> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (sessionId !== undefined && state.sessionId !== undefined && state.sessionId !== sessionId) {
        return undefined;
      }
      const index = state.roster.agents.findLastIndex((agent) => agent.agentId === agentId);
      const existing = state.roster.agents[index];
      if (existing === undefined) return undefined;
      if (existing.diedAt !== undefined) return existing;
      const entry: TowerRosterEntry = {
        ...existing,
        diedAt: new Date().toISOString(),
        deathStatus: status,
        deathReason: reason,
      };
      state.roster.agents[index] = entry;
      await this.save(state);
      const mission = state.missions.find((m) => m.id === entry.missionId);
      await this.appendLog(
        TOWER_NAME,
        'died',
        {
          name: entry.name,
          agent: agentId,
          kind: entry.kind,
          status,
          reason: reason === undefined ? undefined : reason.replaceAll(/\s+/g, ' ').slice(0, 200),
          mission: entry.missionId,
          target: entry.reviewTarget,
          session: sessionId,
          pid: process.pid,
        },
        mission !== undefined ? join(MISSIONS_DIR, missionFileName(mission.id, mission.slug)) : undefined,
      );
      return entry;
    });
  }

  async clearAgentDied(agentId: string, sessionId?: string): Promise<boolean> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (sessionId !== undefined && state.sessionId !== undefined && state.sessionId !== sessionId) {
        return false;
      }
      const index = state.roster.agents.findLastIndex((agent) => agent.agentId === agentId);
      const existing = state.roster.agents[index];
      if (existing === undefined || existing.diedAt === undefined) return false;
      const entry: TowerRosterEntry = {
        ...existing,
        diedAt: undefined,
        deathStatus: undefined,
        deathReason: undefined,
      };
      state.roster.agents[index] = entry;
      await this.save(state);
      await this.appendLog(TOWER_NAME, 'revived', {
        name: entry.name,
        agent: agentId,
        kind: entry.kind,
        session: sessionId,
        pid: process.pid,
      });
      return true;
    });
  }

  async plan(input: readonly TowerPlanInput[]): Promise<readonly TowerMission[]> {
    if (input.length === 0) {
      throw new TowerProtocolError('TowerPlan needs at least one mission');
    }
    for (const item of input) {
      if (hasNonAsciiCharacters(item.title)) {
        const offending = /[^\u0020-\u007E]/.exec(item.title)![0];
        throw new TowerProtocolError(
          `mission title "${item.title}" contains non-ASCII characters (first: "${offending}") — titles must be printable ASCII English: the title becomes the branch/worktree slug, and non-ASCII text slugs to a generic word like "item" that collides across missions; rewrite the title in English with a unique identifier word (e.g. a business code like B010100) and plan again`,
        );
      }
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const startIndex = state.missions.length;

      const missions: TowerMission[] = input.map((item, index) => {
        const n = startIndex + index + 1;
        const slug = slugify(item.title, 40);
        return {
          id: `M${n}`,
          title: item.title,
          slug,
          kind: item.kind ?? 'build',
          scope: [...item.scope],
          branch: `feat/${slug}`,
          worktree: `wt-${n}`,
          deps: [...(item.deps ?? [])],
          status: 'planned',
          context:
            item.context !== undefined && item.context.trim().length > 0
              ? item.context.trim()
              : undefined,
          tasks: (item.tasks ?? []).map((text) => ({ text, done: false })),
          notes: [],
          blockers: [],
        };
      });

      const knownIds = new Set([...state.missions.map((m) => m.id), ...missions.map((m) => m.id)]);
      for (const mission of missions) {
        for (const dep of mission.deps) {
          if (!knownIds.has(dep)) {
            throw new TowerProtocolError(`mission ${mission.id} depends on unknown mission "${dep}"`);
          }
        }
      }
      const takenBranches = new Map(
        state.missions.map((m): [string, TowerMission] => [m.branch, m]),
      );
      for (const mission of missions) {
        const existing = takenBranches.get(mission.branch);
        if (existing !== undefined) {
          throw new TowerProtocolError(
            `mission ${mission.id} branch "${mission.branch}" is already used by ${existing.id} (${existing.status}) "${existing.title}" — change the title so its slug differs; branch-to-mission resolution must stay unambiguous`,
          );
        }
        if (await branchExists(this.repoRoot, mission.branch)) {
          throw new TowerProtocolError(
            `mission ${mission.id} branch "${mission.branch}" already exists in git but is not owned by any tower mission — the worker would start on that branch's unrelated history; change the title so its slug differs, or delete/rename the stale branch if it is a leftover`,
          );
        }
        takenBranches.set(mission.branch, mission);
      }
      const openExisting = state.missions.filter(isOpenMission);
      const byId = new Map<string, TowerMission>();
      for (const existing of [...openExisting, ...missions]) byId.set(existing.id, existing);
      for (const mission of missions) {
        const older = [
          ...openExisting,
          ...missions.filter((m) => missionNumber(m.id) < missionNumber(mission.id)),
        ];
        addAutoDeps(mission, older, byId);
      }
      this.assertScopesDisjoint([
        ...openExisting,
        ...missions,
      ]);

      state.missions.push(...missions);
      await this.save(state);
      await this.renderMissionsIndex(state);
      for (const mission of missions) {
        await this.renderMissionFile(mission);
      }
      await this.appendLog(
        TOWER_NAME,
        'plan',
        { missions: missions.map((m) => m.id).join(',') },
        MISSIONS_INDEX,
      );
      return missions;
    });
  }

  private assertScopesDisjoint(missions: readonly TowerMission[]): void {
    const scopes: Array<{ readonly id: string; readonly raw: string; readonly stem: string }> = [];
    for (const mission of missions) {
      if (mission.kind === 'survey') continue;
      for (const raw of mission.scope) {
        const stem = scopeStem(raw);
        if (stem.length === 0) {
          throw new TowerProtocolError(
            `mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`,
          );
        }
        scopes.push({ id: mission.id, raw, stem });
      }
    }
    const byId = new Map(missions.map((m) => [m.id, m]));
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const a = scopes[i]!;
        const b = scopes[j]!;
        if (a.id === b.id) continue;
        if (a.stem === b.stem || a.stem.startsWith(`${b.stem}/`) || b.stem.startsWith(`${a.stem}/`)) {
          if (depPathExists(a.id, b.id, byId) || depPathExists(b.id, a.id, byId)) continue;
          throw new TowerProtocolError(
            `mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") without a dependency between them — split the shared files into exactly one mission, or wire a dependency so the merges serialize (TowerPlan and scope widening auto-add one when scopes overlap; if one of them is stale finished work, abandon it first (TowerMission status=abandoned))`,
          );
        }
      }
    }
  }

  async updateMission(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    options: { readonly silent?: boolean } = {},
  ): Promise<TowerMission> {
    return this.withStateLock(async () => {
      const state = await this.load();
      return this.updateMissionLocked(callerName, id, patch, state, options);
    });
  }

  private async updateMissionLocked(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    state: TowerState,
    options: { readonly silent?: boolean } = {},
  ): Promise<TowerMission> {
    const mission = state.missions.find((m) => m.id === id);
    if (mission === undefined) {
      throw new TowerProtocolError(`unknown mission "${id}"`);
    }
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'worker' || caller.missionId !== id) {
        throw new TowerProtocolError(
          `agent "${callerName}" does not own mission ${id} — workers update only their own mission file`,
        );
      }
    }

    const isNoOp =
      patch.status === mission.status &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDone === undefined &&
      patch.taskDrop === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined &&
      patch.spawnBase === undefined;
    if (isNoOp) return mission;

    if (patch.status === 'merged') {
      throw new TowerProtocolError(
        `mission ${id} cannot transition to merged through a generic mission patch — only TowerMerge records merged after its merge gate succeeds`,
      );
    }
    if (
      !isOpenMission(mission) &&
      ((patch.status !== undefined && patch.status !== mission.status) ||
        patch.blocker !== undefined)
    ) {
      throw new TowerProtocolError(
        `mission ${id} is ${mission.status} — merged and abandoned are terminal, so a generic mission patch cannot reopen it`,
      );
    }

    if (patch.spawnBase !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot record a mission spawn base — only the tower does`,
        );
      }
      mission.spawnBase = patch.spawnBase;
    }

    if (patch.owner !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot assign mission ownership — only the tower sets owner`,
        );
      }
      mission.owner = patch.owner;
    }
    if (patch.scope !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot change mission scope — only the tower widens a scope, and every change is logged`,
        );
      }
      const patched: TowerMission = { ...mission, scope: [...patch.scope] };
      const others = state.missions.filter((m) => m.id !== id && isOpenMission(m));
      const byId = new Map(state.missions.map((m) => [m.id, m]));
      byId.set(id, patched);
      addAutoDeps(patched, others, byId);
      this.assertScopesDisjoint([...others, patched]);
      mission.scope = [...patch.scope];
    }
    if (patch.status !== undefined) {
      if (patch.status === 'abandoned' && callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot abandon mission ${id} — abandoning releases the mission scope, so only the tower does it`,
        );
      }
      mission.status = patch.status;
    }
    if (patch.note !== undefined) mission.notes.push(patch.note);
    if (patch.blocker !== undefined) {
      mission.blockers.push(patch.blocker);
      mission.status = 'blocked';
    }
    if (patch.clearBlockers === true) mission.blockers = [];
    if (patch.taskDone !== undefined) {
      const task = mission.tasks.find(
        (t) => !t.done && t.dropped !== true && t.text.includes(patch.taskDone!),
      );
      if (task === undefined) {
        throw new TowerProtocolError(
          `mission ${id} has no open task matching "${patch.taskDone}"`,
        );
      }
      task.done = true;
    }
    let taskDropLog: string | undefined;
    if (patch.taskDrop !== undefined) {
      const reason = patch.taskDrop.reason?.trim() ?? '';
      if (reason.length === 0) {
        throw new TowerProtocolError(
          `dropping a task from mission ${id} requires a reason — the drop is the escape hatch for legitimately descoped work, and the reason is recorded in the mission notes and the activity log for audit`,
        );
      }
      const task = mission.tasks.find(
        (t) => !t.done && t.dropped !== true && t.text.includes(patch.taskDrop!.text),
      );
      if (task === undefined) {
        throw new TowerProtocolError(
          `mission ${id} has no open task matching "${patch.taskDrop.text}"`,
        );
      }
      task.dropped = true;
      taskDropLog = `dropped task "${task.text}": ${reason}`;
      mission.notes.push(taskDropLog);
    }
    if (patch.status === 'completed' && patch.blocker === undefined) {
      await this.assertCompletable(state, mission);
      if (callerName !== TOWER_NAME) {
        await this.assertInboxRead(state, callerName, mission);
      }
    }

    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    const taskTickOnly =
      patch.taskDone !== undefined &&
      patch.status === undefined &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDrop === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined &&
      patch.spawnBase === undefined;
    if (!taskTickOnly && options.silent !== true) {
      await this.appendLog(callerName, 'mission.update', {
        id,
        status: patch.status,
        note: patch.note !== undefined ? 'added' : undefined,
        blocker: patch.blocker !== undefined ? 'added' : undefined,
        task_drop: taskDropLog,
        owner: patch.owner,
        scope: patch.scope?.join(','),
        spawn_base: patch.spawnBase,
      });
    }
    return mission;
  }

  private async assertCompletable(state: TowerState, mission: TowerMission): Promise<void> {
    const open = mission.tasks.filter((t) => !t.done && t.dropped !== true);
    if (open.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(open.length)} open task(s): ${open.map((t) => `"${t.text}"`).join(', ')}; tick finished tasks with task_done, or drop legitimately descoped ones with task_drop (a reason is mandatory and lands in the mission notes and the activity log)`,
      );
    }
    if (mission.blockers.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(mission.blockers.length)} blocker(s) remain: ${mission.blockers.join(' | ')}; clear or resolve them before completing`,
      );
    }
    if (mission.kind === 'survey') {
      if (!(await branchExists(this.repoRoot, mission.branch))) return;
      const base = await this.diffBase(state, mission);
      const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
      if (changed.length > 0) {
        throw new TowerProtocolError(
          `mission ${mission.id} cannot transition to completed — it is a read-only survey but branch "${mission.branch}" has ${String(changed.length)} changed file(s) vs "${base}": ${changed.slice(0, 5).join(', ')}; move any changes worth keeping to a build mission and leave the survey branch zero-diff`,
        );
      }
      return;
    }
    if (!(await branchExists(this.repoRoot, mission.branch))) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — its branch "${mission.branch}" does not exist, so no work has landed; a build mission must produce a diff on its branch: spawn a worker to do the work, or have the tower abandon the mission (status=abandoned) if it is no longer needed`,
      );
    }
    const base = await this.diffBase(state, mission);
    const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
    if (changed.length === 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — branch "${mission.branch}" has no changes vs "${base}"; a build mission must produce a diff on its branch: commit the work there first, or if the work turned out unnecessary, have the tower abandon the mission (status=abandoned) instead`,
      );
    }
  }

  private async assertInboxRead(
    state: TowerState,
    callerName: string,
    mission: TowerMission,
  ): Promise<void> {
    const unread = await this.listUnreadInboxItems(state, callerName);
    if (unread.length === 0) return;
    throw new TowerProtocolError(
      `mission ${mission.id} cannot transition to completed — ${String(unread.length)} unread inbox message(s) for ${callerName}; call TowerInbox until no unread messages remain, incorporate anything new into the delivery, then retry status=completed`,
    );
  }

  async send(callerName: string, input: TowerSendInput): Promise<string> {
    return (await this.sendDetailed(callerName, input)).item.file;
  }

  async sendDetailed(callerName: string, input: TowerSendInput): Promise<TowerSendResult> {
    return this.withStateLock(async () => {
      const state = await this.load();
      return this.sendDetailedLocked(callerName, input, state);
    });
  }

  private async sendDetailedLocked(
    callerName: string,
    input: TowerSendInput,
    state: TowerState,
  ): Promise<TowerSendResult> {
    const to = input.to.trim();
    if (
      to !== TOWER_NAME &&
      to !== BROADCAST_NAME &&
      this.findAgent(state, to) === undefined
    ) {
      const known = [TOWER_NAME, BROADCAST_NAME, ...state.roster.agents.map((a) => a.name)];
      throw new TowerProtocolError(
        `unknown recipient "${to}" — address a roster agent, ${TOWER_NAME}, or ${BROADCAST_NAME} (known: ${known.join(', ')})`,
      );
    }
    if (to === callerName) {
      throw new TowerProtocolError('cannot send an inbox message to yourself');
    }

    const messageId = randomUUID();
    const sentAt = new Date().toISOString();
    const body = input.body.trim();
    const frontmatter = renderFrontmatter({
      type: 'inbox',
      message_id: messageId,
      from: callerName,
      to,
      subject: input.subject,
      sent_at: sentAt,
      scope: input.scope,
      action: input.action,
      consent_ref: input.consentRef,
    });
    const content = `${frontmatter}\n\n${body}\n`;
    const baseName = inboxFileName({ from: callerName, to, subject: input.subject });
    const rel = await this.writeUnique(join(INBOX_DIR, baseName), content);
    let activityLogError: string | undefined;
    try {
      await this.appendLog(
        callerName,
        'inbox.send',
        { to, subject: slugify(input.subject) },
        rel,
      );
    } catch (error) {
      activityLogError = `inbox message ${rel} was stored, but appending its inbox.send activity log failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const caller = this.findAgent(state, callerName);
    const recipient =
      to === TOWER_NAME || to === BROADCAST_NAME ? undefined : this.findAgent(state, to);
    const missionId =
      caller?.missionId ??
      caller?.reviewMissionId ??
      (callerName === TOWER_NAME
        ? (recipient?.missionId ?? recipient?.reviewMissionId)
        : undefined);
    return {
      item: {
        messageId,
        file: rel,
        from: callerName,
        to,
        subject: input.subject,
        sentAt,
        scope: input.scope,
        action: input.action,
        consentRef: input.consentRef,
        body,
      },
      missionId,
      activityLogError,
    };
  }

  async complete(
    callerName: string,
    report: string,
  ): Promise<TowerCompleteResult> {
    const trimmed = report.trim();
    if (trimmed.length === 0) {
      throw new TowerProtocolError('TowerComplete report must not be empty');
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const caller = this.findAgent(state, callerName);
      const ownedMission =
        caller?.missionId !== undefined
          ? state.missions.find((mission) => mission.id === caller.missionId)
          : undefined;
      if (callerName === TOWER_NAME || caller?.kind !== 'worker' || ownedMission === undefined) {
        if (caller?.kind === 'worker' && state.recoveredAt !== undefined) {
          return this.completeStateLostLocked(caller, trimmed, state, state.recoveredAt);
        }
        if (caller?.kind === 'worker' && caller.missionId !== undefined) {
          throw new TowerProtocolError(`unknown mission "${caller.missionId}"`);
        }
        throw new TowerProtocolError(
          `agent "${callerName}" cannot use TowerComplete — only the worker who owns a mission can complete it`,
        );
      }
      const beforeMission = ownedMission;
      const wasCompleted = beforeMission.status === 'completed';
      const subject = beforeMission.kind === 'survey' ? 'survey-summary' : 'review-request';
      if (wasCompleted) {
        const existing = await this.findCompletionMessage(
          callerName,
          beforeMission,
          subject,
          trimmed,
        );
        if (existing !== undefined) {
          return {
            mission: beforeMission,
            message: { item: existing, missionId: beforeMission.id },
            notificationCreated: false,
          };
        }
        await this.assertCompletable(state, beforeMission);
        await this.assertInboxRead(state, callerName, beforeMission);
      }
      const mission = await this.updateMissionLocked(
        callerName,
        beforeMission.id,
        { status: 'completed' },
        state,
      );
      try {
        const message = await this.sendDetailedLocked(
          callerName,
          {
            to: TOWER_NAME,
            subject,
            body: trimmed,
            scope: mission.id,
            action: 'complete',
          },
          state,
        );
        return {
          mission,
          message,
          notificationCreated: true,
          activityLogError: message.activityLogError,
        };
      } catch (error) {
        const existing = await this.findCompletionMessage(callerName, mission, subject, trimmed);
        return {
          mission,
          message:
            existing === undefined ? undefined : { item: existing, missionId: mission.id },
          notificationCreated: false,
          notificationError: `mission ${mission.id} was persisted as completed, but storing its ${subject} notification failed: ${error instanceof Error ? error.message : String(error)} — retry with the same report to reuse an already stored notification instead of duplicating it`,
        };
      }
    });
  }

  private async completeStateLostLocked(
    caller: TowerRosterEntry,
    report: string,
    state: TowerState,
    recoveredAt: string,
  ): Promise<TowerCompleteResult> {
    const subject = 'completion-report-state-lost';
    const existing = (await this.listInboxItems()).find(
      (item) =>
        item.from === caller.name &&
        item.to === TOWER_NAME &&
        item.subject === subject &&
        item.action === 'complete' &&
        item.body === report,
    );
    if (existing !== undefined) {
      return {
        recoveredAt,
        message: { item: existing },
        notificationCreated: false,
      };
    }
    try {
      const message = await this.sendDetailedLocked(
        caller.name,
        {
          to: TOWER_NAME,
          subject,
          body: report,
          action: 'complete',
        },
        state,
      );
      return {
        recoveredAt,
        message,
        notificationCreated: true,
        activityLogError: message.activityLogError,
      };
    } catch (error) {
      return {
        recoveredAt,
        notificationCreated: false,
        notificationError: `the tower state was recovered at ${recoveredAt} after a loss, so no mission was marked completed — and storing the degraded completion report also failed: ${error instanceof Error ? error.message : String(error)} — retry with the same report to deliver it`,
      };
    }
  }

  private async findCompletionMessage(
    callerName: string,
    mission: TowerMission,
    subject: string,
    report: string,
  ): Promise<TowerInboxItem | undefined> {
    return (await this.listInboxItems()).find(
      (item) =>
        item.from === callerName &&
        item.to === TOWER_NAME &&
        item.subject === subject &&
        item.scope === mission.id &&
        item.action === 'complete' &&
        item.body === report,
    );
  }

  async readInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const items = (await this.listInboxItems()).filter((item) =>
      this.inboxItemVisibleTo(callerName, item),
    );
    return items.slice(0, Math.max(1, limit));
  }

  async readUnreadInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const state = await this.load();
    const items = await this.listUnreadInboxItems(state, callerName);
    return items.slice(0, Math.max(1, limit));
  }

  async ackInbox(callerName: string, messageIds: readonly string[]): Promise<number> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const index = state.roster.agents.findIndex((agent) => agent.name === callerName);
      const entry = state.roster.agents[index];
      const current = callerName === TOWER_NAME ? state.inboxAckIds : entry?.inboxAckIds;
      const ackIds = new Set(current);
      const previousSize = ackIds.size;
      for (const messageId of messageIds) ackIds.add(messageId);
      let changed = false;
      if (ackIds.size > previousSize) {
        if (callerName === TOWER_NAME) {
          state.inboxAckIds = [...ackIds];
          changed = true;
        } else if (entry !== undefined) {
          state.roster.agents[index] = { ...entry, inboxAckIds: [...ackIds] };
          changed = true;
        }
      }
      if (changed) await this.save(state);
      return (await this.listUnreadInboxItems(state, callerName)).length;
    });
  }

  private inboxItemVisibleTo(callerName: string, item: TowerInboxItem): boolean {
    return callerName === TOWER_NAME || item.to === callerName || item.to === BROADCAST_NAME;
  }

  private async listUnreadInboxItems(
    state: TowerState,
    callerName: string,
  ): Promise<TowerInboxItem[]> {
    return (await this.listInboxItems()).filter(
      (item) =>
        this.inboxItemVisibleTo(callerName, item) && this.isInboxItemUnread(state, callerName, item),
    );
  }

  private isInboxItemUnread(
    state: TowerState,
    callerName: string,
    item: TowerInboxItem,
  ): boolean {
    const entry = callerName === TOWER_NAME ? undefined : this.findAgent(state, callerName);
    const ackIds = callerName === TOWER_NAME ? state.inboxAckIds : entry?.inboxAckIds;
    if (ackIds?.includes(item.messageId) === true) return false;
    if (callerName === TOWER_NAME) return true;
    const since = entry?.lastInboxReadAt ?? entry?.spawnedAt;
    return since === undefined || item.sentAt > since;
  }

  private async listInboxItems(): Promise<TowerInboxItem[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(INBOX_DIR));
    } catch {
      return [];
    }
    const items: TowerInboxItem[] = [];
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const rel = join(INBOX_DIR, file);
      let text: string;
      try {
        text = await readFile(this.abs(rel), 'utf8');
      } catch {
        continue;
      }
      const { fields, body } = parseFrontmatter(text);
      if (fields['type'] !== 'inbox') continue;
      items.push({
        messageId: fields['message_id'] ?? rel,
        file: rel,
        from: fields['from'] ?? 'unknown',
        to: fields['to'] ?? '',
        subject: fields['subject'] ?? '',
        sentAt: fields['sent_at'] ?? '',
        scope: fields['scope'],
        action: fields['action'],
        consentRef: fields['consent_ref'],
        body,
      });
    }
    items.sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.file.localeCompare(b.file));
    return items;
  }

  async fileFinding(callerName: string, input: TowerFindingInput): Promise<string> {
    if (!FINDING_TYPES.includes(input.type)) {
      throw new TowerProtocolError(
        `finding type must be one of ${FINDING_TYPES.join(' | ')}`,
      );
    }
    const state = await this.load();
    const caller = this.findAgent(state, callerName);
    const mission =
      caller?.missionId !== undefined
        ? state.missions.find((m) => m.id === caller.missionId)
        : undefined;

    const lines = [
      `# Finding: ${input.title}`,
      '',
      `**Date**: ${dateDash().replaceAll('-', '')}`,
      `**Agent**: ${callerName}`,
      `**Type**: ${input.type}`,
      `**Severity**: ${input.severity ?? 'medium'}`,
      `**Mission**: ${mission === undefined ? '(none)' : `${mission.id} — ${mission.title}`}`,
      '',
      '---',
      '',
      '## Summary',
      input.summary.trim(),
      '',
      '## Location',
      (input.location ?? '(not specified)').trim(),
      '',
      '## Details',
      input.details.trim(),
      '',
      '## Suggested Fix / Action',
      input.suggestedFix.trim(),
      '',
      '## Why Not Fixed Directly',
      mission === undefined
        ? 'This finding is outside the reporting agent’s assignment. Assigning to the control tower for routing.'
        : `This finding is outside the scope of mission ${mission.id} (${mission.scope.join(', ')}). Fixing it directly would violate scope isolation. Assigning to the control tower for routing.`,
      '',
      '---',
      '',
      `*Filed by tower agent ${callerName} via \`${FINDINGS_DIR}/\`*`,
      '',
    ];
    const baseName = findingFileName({
      agent: callerName,
      type: input.type,
      slug: input.title,
    });
    const rel = await this.writeUnique(join(FINDINGS_DIR, baseName), lines.join('\n'));
    await this.appendLog(
      callerName,
      'finding.file',
      { type: input.type, slug: slugify(input.title) },
      rel,
    );
    return rel;
  }

  async submitReview(callerName: string, input: TowerReviewInput): Promise<TowerReviewResult> {
    return this.withStateLock(async () => {
      const state = await this.load();
      let callerEntry: TowerRosterEntry | undefined;
      if (callerName !== TOWER_NAME) {
        callerEntry = this.findAgent(state, callerName);
        if (callerEntry?.kind !== 'reviewer' || callerEntry.reviewTarget !== input.target) {
          throw new TowerProtocolError(
            `agent "${callerName}" is not an assigned reviewer for "${input.target}"`,
          );
        }
      }
      if (!/^(clean|p[12]-\d+items)$/.test(input.status)) {
        throw new TowerProtocolError(
          `review status must be clean | p1-Nitems | p2-Nitems, got "${input.status}"`,
        );
      }
      if (!['merge', 'fix-then-merge', 'hold'].includes(input.merge)) {
        throw new TowerProtocolError(
          `review merge verdict must be merge | fix-then-merge | hold, got "${input.merge}"`,
        );
      }

      const existing = await this.reviewsFor(input.target);
      const reviewedCommit = await branchTip(this.repoRoot, input.target);
      const reviewMissionId =
        callerEntry === undefined
          ? resolveMissionByBranch(state, input.target)?.id
          : callerEntry.reviewMissionId;
      const reviewMission =
        reviewMissionId !== undefined
          ? state.missions.find((mission) => mission.id === reviewMissionId)
          : resolveMissionByBranch(state, input.target);
      const activityLogErrors: string[] = [];
      let review = await this.findReviewRecovery(
        state,
        callerName,
        input,
        existing,
        reviewedCommit,
        reviewMission,
      );
      if (review !== undefined && !(await this.hasActivityLogRef('review.write', review.file))) {
        try {
          await this.appendLog(
            callerName,
            'review.write',
            {
              target: input.target,
              round: review.round,
              verdict: review.status,
              reviewed: review.reviewedCommit.slice(0, 7),
            },
            review.file,
          );
        } catch (error) {
          activityLogErrors.push(
            `review ${review.file} was stored, but appending its review.write activity log failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (review === undefined) {
        const myRounds = existing.filter((candidate) => candidate.reviewer === callerName).length;
        if (myRounds >= MAX_REVIEW_ROUNDS) {
          throw new TowerProtocolError(
            `branch "${input.target}" has already been through ${String(MAX_REVIEW_ROUNDS)} review rounds by "${callerName}" — the rework loop is not converging, so another round from the same reviewer is refused; redirect instead: reassign the work (spawn a different worker or a fresh reviewer), split the mission into smaller pieces, or descope it (TowerMission status=abandoned)`,
          );
        }
        const round = myRounds + 1;
        const seq = await this.nextReviewSeq();
        const date = dateDash();
        const frontmatter = renderFrontmatter({
          date,
          reviewer: callerName,
          target: input.target,
          round: String(round),
          seq: String(seq),
          status: input.status,
          merge: input.merge,
          reviewed_commit: reviewedCommit,
          mission: reviewMissionId,
        });
        const content = `${frontmatter}\n\n${reviewDocumentBody(input)}\n`;
        const rel = await this.writeUnique(
          join(REVIEWS_DIR, reviewFileName({ target: input.target, reviewer: callerName, round })),
          content,
        );
        review = {
          reviewer: callerName,
          target: input.target,
          round,
          status: input.status,
          merge: input.merge,
          reviewedCommit,
          date,
          file: rel,
          mtimeMs: (await stat(this.abs(rel))).mtimeMs,
          seq,
          mission: reviewMissionId,
        };
        try {
          await this.appendLog(
            callerName,
            'review.write',
            {
              target: input.target,
              round,
              verdict: input.status,
              reviewed: reviewedCommit.slice(0, 7),
            },
            rel,
          );
        } catch (error) {
          activityLogErrors.push(
            `review ${rel} was stored, but appending its review.write activity log failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (input.status !== 'clean' && reviewMission?.status === 'completed') {
        reviewMission.status = 'active';
        await this.save(state);
        await this.renderMissionsIndex(state);
        await this.renderMissionFile(reviewMission);
        try {
          await this.appendLog(
            callerName,
            'mission.rework',
            { id: reviewMission.id, verdict: input.status },
            join(MISSIONS_DIR, missionFileName(reviewMission.id, reviewMission.slug)),
          );
        } catch (error) {
          activityLogErrors.push(
            `mission ${reviewMission.id} was marked active, but appending mission.rework activity log failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const { storedMessages, notificationErrors } = await this.storeReviewMessages(
        state,
        callerName,
        input,
        review,
        reviewMission,
        activityLogErrors,
      );
      return {
        review,
        storedMessages,
        notificationError:
          notificationErrors.length > 0
            ? `review ${review.file} was stored, but storing review-result notification(s) failed: ${notificationErrors.join(' | ')}`
            : undefined,
        activityLogError:
          activityLogErrors.length > 0 ? activityLogErrors.join(' | ') : undefined,
      };
    });
  }

  private async findReviewRecovery(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    existing: readonly TowerReviewInfo[],
    reviewedCommit: string,
    reviewMission: TowerMission | undefined,
  ): Promise<TowerReviewInfo | undefined> {
    const expectedBody = reviewDocumentBody(input);
    const recipients = this.reviewRecipients(state, callerName, input, reviewMission);
    for (const candidate of existing.toReversed()) {
      if (
        candidate.reviewer !== callerName ||
        candidate.reviewedCommit !== reviewedCommit ||
        candidate.status !== input.status ||
        candidate.merge !== input.merge
      ) {
        continue;
      }
      const { body } = parseFrontmatter(await readFile(this.abs(candidate.file), 'utf8'));
      if (body !== expectedBody) continue;
      if (!(await this.hasActivityLogRef('review.write', candidate.file))) return candidate;
      const messages = await this.listInboxItems();
      let needsRecovery = false;
      for (const recipient of recipients) {
        const message = messages.find(
          (item) => this.isReviewResultMessage(item, callerName, recipient, candidate, reviewMission, input),
        );
        if (message === undefined || !(await this.hasActivityLogRef('inbox.send', message.file))) {
          needsRecovery = true;
          break;
        }
      }
      if (needsRecovery) return candidate;
      return undefined;
    }
    return undefined;
  }

  private async storeReviewMessages(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    activityLogErrors: string[],
  ): Promise<{
    readonly storedMessages: readonly TowerSendResult[];
    readonly notificationErrors: readonly string[];
  }> {
    const recipients = this.reviewRecipients(state, callerName, input, reviewMission);
    const body = this.reviewNotificationBody(review, reviewMission, input);
    const messages = await this.listInboxItems();
    const storedMessages: TowerSendResult[] = [];
    const notificationErrors: string[] = [];
    for (const recipient of recipients) {
      const existing = messages.find(
        (item) => this.isReviewResultMessage(item, callerName, recipient, review, reviewMission, input),
      );
      if (existing !== undefined) {
        storedMessages.push({
          item: existing,
          missionId: reviewMission?.id ?? review.mission,
        });
        if (!(await this.hasActivityLogRef('inbox.send', existing.file))) {
          try {
            await this.appendLog(
              callerName,
              'inbox.send',
              { to: recipient, subject: slugify('review-result') },
              existing.file,
            );
          } catch (error) {
            activityLogErrors.push(
              `inbox message ${existing.file} was stored, but appending its inbox.send activity log failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        continue;
      }
      try {
        const sent = await this.sendDetailedLocked(
          callerName,
          {
            to: recipient,
            subject: 'review-result',
            body,
            scope: reviewMission?.id ?? review.mission,
            action: 'review-result',
          },
          state,
        );
        storedMessages.push(sent);
        if (sent.activityLogError !== undefined) activityLogErrors.push(sent.activityLogError);
      } catch (error) {
        notificationErrors.push(
          `${recipient}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { storedMessages, notificationErrors };
  }

  private reviewRecipients(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    reviewMission: TowerMission | undefined,
  ): readonly string[] {
    const owner =
      reviewMission !== undefined && isOpenMission(reviewMission) && reviewMission.owner !== undefined
        ? state.roster.agents.find(
            (agent) =>
              agent.name === reviewMission.owner &&
              agent.kind === 'worker' &&
              agent.missionId === reviewMission.id &&
              agent.diedAt === undefined,
          )
        : undefined;
    const recipients: string[] = [];
    if (input.status !== 'clean' && owner !== undefined && owner.name !== callerName) {
      recipients.push(owner.name);
    }
    if (callerName !== TOWER_NAME) recipients.push(TOWER_NAME);
    return recipients;
  }

  private reviewNotificationBody(
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    input: TowerReviewInput,
  ): string {
    return [
      `file: ${review.file}`,
      `target: ${review.target}`,
      `mission: ${reviewMission?.id ?? review.mission ?? '(none)'}`,
      `round: ${String(review.round)}`,
      `verdict: ${input.status}`,
      `merge recommendation: ${input.merge}`,
      `reviewedCommit: ${review.reviewedCommit}`,
      `owner: ${reviewMission?.owner ?? '(none)'}`,
    ].join('\n');
  }

  private isReviewResultMessage(
    item: TowerInboxItem,
    callerName: string,
    recipient: string,
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    input: TowerReviewInput,
  ): boolean {
    return (
      item.from === callerName &&
      item.to === recipient &&
      item.subject === 'review-result' &&
      item.scope === (reviewMission?.id ?? review.mission) &&
      item.action === 'review-result' &&
      item.body === this.reviewNotificationBody(review, reviewMission, input)
    );
  }

  private async hasActivityLogRef(action: string, rel: string): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.abs(ACTIVITY_LOG), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    return content
      .split('\n')
      .some((line) => line.includes(` ${action} `) && line.endsWith(`ref=${rel}`));
  }

  async reviewsFor(target: string): Promise<readonly TowerReviewInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(REVIEWS_DIR));
    } catch {
      return [];
    }
    const prefix = `review-${targetSlug(target)}-`;
    const reviews: TowerReviewInfo[] = [];
    for (const file of files.filter((f) => f.startsWith(prefix) && f.endsWith('.md'))) {
      const rel = join(REVIEWS_DIR, file);
      let text: string;
      try {
        text = await readFile(this.abs(rel), 'utf8');
      } catch {
        continue;
      }
      const { fields } = parseFrontmatter(text);
      const round = Number.parseInt(fields['round'] ?? '', 10);
      if (Number.isNaN(round)) continue;
      const seq = Number.parseInt(fields['seq'] ?? '', 10);
      const { mtimeMs } = await stat(this.abs(rel));
      reviews.push({
        reviewer: fields['reviewer'] ?? 'unknown',
        target: fields['target'] ?? target,
        round,
        status: fields['status'] ?? '',
        merge: fields['merge'] ?? '',
        reviewedCommit: fields['reviewed_commit'] ?? '',
        date: fields['date'] ?? '',
        file: rel,
        mtimeMs,
        seq: Number.isNaN(seq) ? undefined : seq,
        mission: fields['mission'],
      });
    }
    reviews.sort(
      (a, b) =>
        (a.seq ?? -1) - (b.seq ?? -1) ||
        a.mtimeMs - b.mtimeMs ||
        a.round - b.round ||
        a.file.localeCompare(b.file),
    );
    return reviews;
  }

  async latestReview(target: string): Promise<TowerReviewInfo | undefined> {
    const reviews = await this.reviewsFor(target);
    return reviews.at(-1);
  }

  private async nextReviewSeq(): Promise<number> {
    let files: string[];
    try {
      files = await readdir(this.abs(REVIEWS_DIR));
    } catch {
      return 1;
    }
    let max = 0;
    for (const file of files.filter((f) => f.startsWith('review-') && f.endsWith('.md'))) {
      let text: string;
      try {
        text = await readFile(this.abs(join(REVIEWS_DIR, file)), 'utf8');
      } catch {
        continue;
      }
      const seq = Number.parseInt(parseFrontmatter(text).fields['seq'] ?? '', 10);
      if (!Number.isNaN(seq) && seq > max) max = seq;
    }
    return max + 1;
  }

  async merge(
    branch: string,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMergeResult> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const block = async (reason: string, message: string): Promise<TowerProtocolError> => {
        await this.appendLog(TOWER_NAME, 'merge.blocked', { branch, reason });
        return new TowerProtocolError(message);
      };
      const mission = resolveMissionByBranch(state, branch);
      if (mission === undefined) {
        const closed = state.missions.filter((candidate) => candidate.branch === branch);
        if (closed.length > 0) {
          throw await block(
            'branch-owned-by-closed-missions',
            `merge blocked: branch "${branch}" resolves only to closed mission(s) ${closed.map((candidate) => `${candidate.id} (${candidate.status})`).join(', ')} — TowerMerge never flips a closed mission's status; re-plan the work under a new title if it should land`,
          );
        }
        throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
      }

      const gate = await this.missionGate(state, mission, runtime);
      if (!gate.ready) {
        const primary = gate.blocks[0]!;
        throw await block(primary.reason, primary.message);
      }
      const observation = gate.observations.branch!;
      const evaluatedBranchTip = observation.tip;

      if (gate.noop) {
        const currentBranchTip = await branchTip(this.repoRoot, branch);
        if (currentBranchTip !== evaluatedBranchTip) {
          await this.appendLog(TOWER_NAME, 'merge.advanced', {
            branch,
            evaluated: evaluatedBranchTip.slice(0, 7),
            current: currentBranchTip.slice(0, 7),
          });
          return {
            status: 'advanced',
            mergeCommit: gate.observations.headTip,
            evaluatedBranchTip,
            currentBranchTip,
            conflictsWith: [],
            noop: true,
          };
        }
        mission.status = 'merged';
        await this.save(state);
        await this.renderMissionsIndex(state);
        await this.renderMissionFile(mission);
        await this.appendLog(TOWER_NAME, 'merge.noop', { branch, kind: 'survey' });
        return {
          status: 'noop',
          mergeCommit: gate.observations.headTip,
          evaluatedBranchTip,
          currentBranchTip,
          conflictsWith: [],
          noop: true,
        };
      }

      const mergeCommit = await mergeNoFf(
        this.repoRoot,
        evaluatedBranchTip,
        `Merge branch '${branch}'`,
      );
      const headTip = await branchTip(this.repoRoot, 'HEAD');
      if (!(await isAncestor(this.repoRoot, evaluatedBranchTip, headTip))) {
        throw new TowerProtocolError(
          `recovery-required: merge of ${branch} returned but HEAD ${headTip} does not contain the evaluated commit ${evaluatedBranchTip} — mission ${mission.id} was not marked merged; inspect the base checkout before retrying`,
        );
      }
      const currentBranchTip = await branchTip(this.repoRoot, branch);
      if (currentBranchTip !== evaluatedBranchTip) {
        await this.appendLog(TOWER_NAME, 'merge.advanced', {
          branch,
          evaluated: evaluatedBranchTip.slice(0, 7),
          current: currentBranchTip.slice(0, 7),
          merge_commit: mergeCommit.slice(0, 7),
        });
        return {
          status: 'advanced',
          mergeCommit,
          evaluatedBranchTip,
          currentBranchTip,
          conflictsWith: [],
        };
      }

      const changedSet = new Set(observation.changedFiles);
      const conflictsWith: Array<{ readonly branch: string; readonly files: readonly string[] }> = [];
      for (const other of state.missions) {
        if (other.branch === branch || !isOpenMission(other)) continue;
        if (!(await branchExists(this.repoRoot, other.branch))) continue;
        const otherChanged = await diffNameOnly(
          this.repoRoot,
          await this.diffBase(state, other),
          other.branch,
        );
        const overlap = otherChanged.filter((file) => changedSet.has(file));
        if (overlap.length > 0) {
          conflictsWith.push({ branch: other.branch, files: overlap });
        }
      }

      mission.status = 'merged';
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      await this.appendLog(TOWER_NAME, 'merge', {
        branch,
        base: state.base,
        merge_commit: mergeCommit.slice(0, 7),
        review_waived: gate.reviewBinding === 'clean-rebase-waived' ? 'yes' : undefined,
      });
      return {
        status: 'merged',
        mergeCommit,
        evaluatedBranchTip,
        currentBranchTip,
        conflictsWith,
      };
    });
  }

  async missionGate(
    state: TowerState,
    mission: TowerMission,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMissionGateResult> {
    const reviews = await this.reviewsFor(mission.branch);
    const observations = await this.observeMissionGit(state, mission);
    const activeAgentIds =
      typeof runtime.activeAgentIds === 'function'
        ? runtime.activeAgentIds()
        : runtime.activeAgentIds;
    const workers = state.roster.agents
      .filter(
        (agent) =>
          agent.kind === 'worker' &&
          (agent.missionId === mission.id ||
            agent.branch === mission.branch ||
            agent.worktree === mission.worktree),
      )
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        status:
          activeAgentIds === undefined
            ? ('unknown' as const)
            : activeAgentIds.has(agent.agentId)
              ? ('busy' as const)
              : ('idle' as const),
      }));
    return evaluateMissionGate({ state, mission, reviews, workers, observations });
  }

  private async observeMissionGit(
    state: TowerState,
    mission: TowerMission,
  ): Promise<TowerMissionGitObservations> {
    const baseTip = await branchTip(this.repoRoot, state.base);
    const headTip = await branchTip(this.repoRoot, 'HEAD');
    let checkedOutBranch: string | undefined;
    try {
      checkedOutBranch = await currentBranch(this.repoRoot);
    } catch (error) {
      if (error instanceof GitError) throw error;
    }
    const baseDirtyFiles = (await listBaseDirtyEntries(this.repoRoot)).map((entry) => entry.path);
    if (!(await branchExists(this.repoRoot, mission.branch))) {
      return { baseTip, headTip, checkedOutBranch, baseDirtyFiles };
    }
    const tip = await branchTip(this.repoRoot, mission.branch);
    const baseIsAncestor = await isAncestor(this.repoRoot, baseTip, tip);
    const diffBase =
      mission.spawnBase !== undefined && (await isAncestor(this.repoRoot, mission.spawnBase, tip))
        ? mission.spawnBase
        : baseTip;
    const changedFiles = await diffNameOnly(this.repoRoot, diffBase, tip);
    const mergeTouchedFiles = await diffNameOnly(this.repoRoot, headTip, tip);
    return {
      baseTip,
      headTip,
      checkedOutBranch,
      baseDirtyFiles,
      branch: { tip, baseIsAncestor, diffBase, changedFiles, mergeTouchedFiles },
    };
  }

  async rebaseMission(
    callerName: string,
    id: string,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerRebaseMissionResult> {
    return this.withStateLock(async () => {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot rebase a mission branch — only the tower runs TowerRebase; a worker rebases only when the tower asks it to`,
        );
      }
      const state = await this.load();
      const mission = state.missions.find((candidate) => candidate.id === id);
      if (mission === undefined) {
        throw new TowerProtocolError(`unknown mission "${id}"`);
      }
      if (!isOpenMission(mission)) {
        throw new TowerProtocolError(
          `mission ${id} is ${mission.status} — only open missions rebase; closed missions are historical records`,
        );
      }
      if (mission.kind === 'survey') {
        throw new TowerProtocolError(
          `mission ${id} is a read-only survey — it has no work branch to rebase`,
        );
      }
      const activeAgentIds =
        typeof runtime.activeAgentIds === 'function'
          ? runtime.activeAgentIds()
          : runtime.activeAgentIds;
      const workers = state.roster.agents.filter(
        (agent) =>
          agent.kind === 'worker' &&
          (agent.missionId === mission.id ||
            agent.branch === mission.branch ||
            agent.worktree === mission.worktree),
      );
      const busyWorkers = workers.filter(
        (worker) => activeAgentIds?.has(worker.agentId) === true,
      );
      if (busyWorkers.length > 0) {
        throw new TowerProtocolError(
          `worker(s) ${busyWorkers.map((worker) => worker.name).join(', ')} are mid-turn — rebasing under a running worker could race its edits; TowerSend a message asking for a worker-run rebase, or retry once every worker is idle`,
        );
      }
      if (activeAgentIds === undefined && workers.length > 0) {
        throw new TowerProtocolError(
          `worker runtime for ${workers.map((worker) => worker.name).join(', ')} cannot be observed authoritatively — unknown is not idle; retry TowerRebase from the main tower agent`,
        );
      }
      if (!(await branchExists(this.repoRoot, mission.branch))) {
        throw new TowerProtocolError(
          `mission ${id} has no branch "${mission.branch}" yet — spawn a worker to create it before rebasing`,
        );
      }
      const worktreeAbs = this.abs(join(WORKTREES_DIR, mission.worktree));
      if (!(await isRegisteredWorktree(this.repoRoot, worktreeAbs))) {
        throw new TowerProtocolError(
          `mission ${id} has no registered worktree at ${join(WORKTREES_DIR, mission.worktree)} — spawn a worker to create it before rebasing`,
        );
      }
      if (await isWorktreeDirty(worktreeAbs)) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} has uncommitted changes — rebasing under uncommitted work could lose it; have the worker commit or stash first, then retry`,
        );
      }
      const gitDir = resolve(worktreeAbs, (await git(worktreeAbs, ['rev-parse', '--git-dir'])).trim());
      if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} already has a rebase in progress — finish or abort it (git rebase --continue / --abort in the worktree) before the tower rebases the branch`,
        );
      }
      const baseCommit = await branchTip(this.repoRoot, state.base);
      const fromCommit = await branchTip(this.repoRoot, mission.branch);
      const checkedOut = await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (checkedOut !== mission.branch) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} is on "${checkedOut}", not mission branch "${mission.branch}" — restore the registered checkout before rebasing; nothing was changed`,
        );
      }
      const worktreeHead = await branchTip(worktreeAbs, 'HEAD');
      if (worktreeHead !== fromCommit) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} HEAD ${worktreeHead} does not match mission branch "${mission.branch}" at ${fromCommit} — repair the diverged checkout before rebasing; nothing was changed`,
        );
      }
      if (await isAncestor(this.repoRoot, baseCommit, fromCommit)) {
        await this.appendLog(TOWER_NAME, 'rebase.mission', { id, result: 'up-to-date' });
        return { status: 'up-to-date' };
      }

      let rebaseErrorMessage: string | undefined;
      try {
        await git(worktreeAbs, ['rebase', baseCommit]);
      } catch (error) {
        rebaseErrorMessage = error instanceof Error ? error.message : 'non-Error thrown value';
      }
      if (rebaseErrorMessage !== undefined) {
        let conflicted: string;
        let inProgress: boolean;
        try {
          conflicted = await git(worktreeAbs, ['diff', '--name-only', '--diff-filter=U']);
          inProgress =
            existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
        } catch (error) {
          throw new TowerProtocolError(
            `recovery-required: rebase of mission ${id} failed and its state could not be inspected: ${error instanceof Error ? error.message : String(error)} — no waiver was recorded and the mission was not marked blocked`,
          );
        }
        const files = conflicted.split('\n').filter((file) => file.trim().length > 0);
        if (inProgress) {
          try {
            await git(worktreeAbs, ['rebase', '--abort']);
          } catch (error) {
            throw new TowerProtocolError(
              `recovery-required: rebase of mission ${id} failed and git rebase --abort also failed: ${error instanceof Error ? error.message : String(error)} — no recovery is claimed, no waiver was recorded, and the mission was not marked blocked`,
            );
          }
        }
        await this.assertRebaseRecovered(worktreeAbs, gitDir, mission, fromCommit);
        if (inProgress && files.length > 0) {
          mission.blockers.push(
            `tower rebase onto ${state.base} conflicted in: ${files.join(', ')} — the rebase was aborted and your worktree is back to the pre-rebase state. Resolve it yourself: run \`git rebase ${state.base}\` in your worktree, fix the listed conflicts, \`git add\` the resolved files, then continue with \`GIT_EDITOR=true git rebase --continue\` (a plain \`git rebase --continue\` opens an editor and hangs a non-interactive shell). Re-run your tests, then clear this blocker (TowerMission clear_blockers) and TowerSend the tower asking for a fresh review — a worker-run rebase is not covered by the clean-rebase waiver, so the moved tip needs a new clean review before the merge can land`,
          );
          mission.status = 'blocked';
          await this.save(state);
          await this.renderMissionsIndex(state);
          await this.renderMissionFile(mission);
          await this.appendLog(TOWER_NAME, 'rebase.mission', {
            id,
            result: 'conflict',
            files: files.join(','),
          });
          return { status: 'conflict', fromCommit, files };
        }
        throw new TowerProtocolError(
          `rebase of mission ${id} failed: ${rebaseErrorMessage} — no rebase conflict with unmerged paths was observed, so the mission was not marked blocked and no review waiver was recorded`,
        );
      }

      let toCommit: string;
      const problems: string[] = [];
      try {
        toCommit = await branchTip(this.repoRoot, mission.branch);
        if ((await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== mission.branch) {
          problems.push('the worktree no longer has the mission branch checked out');
        }
        if ((await branchTip(worktreeAbs, 'HEAD')) !== toCommit) {
          problems.push('worktree HEAD and the mission branch tip differ');
        }
        if (await isWorktreeDirty(worktreeAbs)) problems.push('the worktree is dirty');
        if (!(await isAncestor(this.repoRoot, baseCommit, toCommit))) {
          problems.push('the rebased branch does not contain the evaluated base commit');
        }
      } catch (error) {
        throw new TowerProtocolError(
          `recovery-required: rebase of mission ${id} returned success but its postconditions could not be inspected: ${error instanceof Error ? error.message : String(error)} — no review waiver was recorded`,
        );
      }
      if (problems.length > 0) {
        throw new TowerProtocolError(
          `recovery-required: rebase of mission ${id} returned success but its postconditions failed (${problems.join('; ')}) — no review waiver was recorded; inspect the worktree and branch before retrying`,
        );
      }
      mission.lastRebase = { fromCommit, toCommit };
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      await this.appendLog(TOWER_NAME, 'rebase.mission', {
        id,
        result: 'clean',
        from: fromCommit.slice(0, 7),
        to: toCommit.slice(0, 7),
      });
      return { status: 'rebased', fromCommit, toCommit };
    });
  }

  private async assertRebaseRecovered(
    worktreeAbs: string,
    gitDir: string,
    mission: TowerMission,
    fromCommit: string,
  ): Promise<void> {
    const problems: string[] = [];
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      problems.push('a rebase is still in progress');
    }
    try {
      if ((await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== mission.branch) {
        problems.push('the mission branch is not checked out');
      }
      if ((await branchTip(worktreeAbs, 'HEAD')) !== fromCommit) {
        problems.push('worktree HEAD was not restored to the pre-rebase commit');
      }
      if ((await branchTip(this.repoRoot, mission.branch)) !== fromCommit) {
        problems.push('the mission branch tip was not restored');
      }
      if (await isWorktreeDirty(worktreeAbs)) problems.push('the worktree is not clean');
    } catch (error) {
      problems.push(`recovery inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (problems.length > 0) {
      throw new TowerProtocolError(
        `recovery-required: rebase recovery for mission ${mission.id} failed its postconditions (${problems.join('; ')}) — no recovery is claimed, no waiver was recorded, and the mission was not marked blocked`,
      );
    }
  }

  async diffBase(state: TowerState, mission: TowerMission): Promise<string> {
    if (
      mission.spawnBase !== undefined &&
      (await isAncestor(this.repoRoot, mission.spawnBase, mission.branch))
    ) {
      return mission.spawnBase;
    }
    return state.base;
  }

  async addWorktree(worktree: string, branch: string, base: string): Promise<TowerAddWorktreeResult> {
    const rel = join(WORKTREES_DIR, worktree);
    let spawnBase: string | undefined;
    if (await branchExists(this.repoRoot, branch)) {
      const state = await this.load();
      const mission = state.missions.find((m) => m.worktree === worktree && m.branch === branch);
      const registered = await isRegisteredWorktree(this.repoRoot, this.abs(rel));
      const checkedOut = registered
        ? await tryGit(this.abs(rel), ['rev-parse', '--abbrev-ref', 'HEAD'])
        : null;
      if (mission?.owner === undefined && checkedOut?.trim() !== branch) {
        throw new TowerProtocolError(unownedBranchMessage(branch));
      }
      await worktreeAdd(this.repoRoot, this.abs(rel), branch);
      await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base, spawn_base: spawnBase });
      return { rel, spawnBase };
    }
    const dirty = await listBaseDirtyEntries(this.repoRoot);
    if (dirty.some((entry) => entry.unmerged)) {
      throw new TowerProtocolError(
        'the base checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before spawning workers',
      );
    }
    if (dirty.length > 0) {
      let checkout: string;
      try {
        checkout = await currentBranch(this.repoRoot);
      } catch {
        throw new TowerProtocolError(
          `the main checkout is in a detached HEAD state with uncommitted changes, and the recorded base is "${base}" — a WIP snapshot would carry detached-HEAD content into the mission branch; check out "${base}" (\`git checkout ${base}\`) or commit/stash the changes before spawning workers`,
        );
      }
      if (checkout !== base) {
        throw new TowerProtocolError(
          `the main checkout is on "${checkout}" with uncommitted changes, not the recorded base "${base}" — a WIP snapshot would carry "${checkout}" content into the mission branch; switch back to "${base}" (\`git checkout ${base}\`) or commit/stash the changes before spawning workers`,
        );
      }
    }
    spawnBase =
      (await snapshotBaseWip(
        this.repoRoot,
        base,
        dirty.map((entry) => entry.path),
        `tower: snapshot of uncommitted base checkout changes (worktree ${worktree})`,
      )) ?? undefined;
    try {
      await worktreeAddNewBranch(this.repoRoot, this.abs(rel), branch, spawnBase ?? base);
    } catch (error) {
      if (await branchExists(this.repoRoot, branch)) {
        throw new TowerProtocolError(unownedBranchMessage(branch));
      }
      throw error;
    }
    await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base, spawn_base: spawnBase });
    return { rel, spawnBase };
  }

  async teardown(options: TowerTeardownOptions = {}): Promise<readonly string[]> {
    const state = await this.load();
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const liveAgentIds = options.liveAgentIds ?? new Set<string>();
    const excluded = new Map<string, string>();
    for (const raw of options.exclude ?? []) {
      const trimmed = raw.trim().replace(/\/+$/, '');
      if (trimmed.length === 0) continue;
      const short = trimmed.startsWith(`${WORKTREES_DIR}/`)
        ? trimmed.slice(WORKTREES_DIR.length + 1)
        : trimmed;
      excluded.set(short, raw);
    }
    const report: string[] = [];
    const kept = async (
      mission: TowerMission,
      rel: string,
      reason: string,
      log: Record<string, string | number | undefined>,
    ): Promise<void> => {
      report.push(`${dryRun ? 'would keep' : 'kept'} ${rel} (${reason})`);
      if (!dryRun) {
        await this.appendLog(TOWER_NAME, 'worktree.keep', {
          worktree: mission.worktree,
          ...log,
        });
      }
    };
    for (const mission of state.missions) {
      const rel = join(WORKTREES_DIR, mission.worktree);
      const absPath = this.abs(rel);
      const wasExcluded = excluded.delete(mission.worktree);
      if (!(await isRegisteredWorktree(this.repoRoot, absPath))) {
        report.push(`already removed ${rel}`);
        if (!dryRun) {
          await this.appendLog(TOWER_NAME, 'worktree.remove.skipped', {
            worktree: mission.worktree,
            reason: 'already-removed',
          });
        }
        continue;
      }
      if (wasExcluded) {
        await kept(mission, rel, 'excluded', { reason: 'excluded' });
        continue;
      }
      const liveAgent = state.roster.agents.find(
        (agent) => agent.worktree === mission.worktree && liveAgentIds.has(agent.agentId),
      );
      if (liveAgent !== undefined) {
        await kept(mission, rel, `live agent: ${liveAgent.name}`, {
          reason: 'live-agent',
          agent: liveAgent.name,
        });
        continue;
      }
      if (!force) {
        if (await isWorktreeDirty(absPath)) {
          await kept(mission, rel, 'uncommitted changes — rerun with force to remove', {
            reason: 'uncommitted-changes',
          });
          continue;
        }
      }
      if (dryRun) {
        report.push(`would remove ${rel}`);
        continue;
      }
      try {
        await worktreeRemove(this.repoRoot, absPath);
        report.push(`removed ${rel}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove', { worktree: mission.worktree });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.push(`failed to remove ${rel}: ${reason}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove.failed', {
          worktree: mission.worktree,
          reason,
        });
      }
    }
    for (const original of excluded.values()) {
      report.push(`excluded worktree "${original}" matched no mission worktree`);
    }
    if (!dryRun) {
      await this.appendLog(TOWER_NAME, 'teardown', { force: force ? 'yes' : undefined });
    }
    return report;
  }

  private async renderMissionsIndex(state: TowerState): Promise<void> {
    const rows = state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} | ${m.owner ?? '—'} |`,
    );
    const deps = state.missions
      .flatMap((m) => m.deps.map((dep) => `${dep} → ${m.id}`))
      .join('\n');
    const scopes = state.missions
      .map((m) => `- ${m.id}${m.kind === 'survey' ? ' (survey — informational, reserves nothing)' : ''}: ${m.scope.join(', ')}`)
      .join('\n');
    const content = [
      '# MISSIONS',
      '',
      '<!-- Generated by tower tools from state.json — do not edit by hand. -->',
      '',
      '| ID | Mission | Branch | Worktree | Status | Owner |',
      '| -- | ------- | ------ | -------- | ------ | ----- |',
      ...rows,
      '',
      'Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged · 🚫 abandoned',
      `Mode: ${state.mode} — Base: ${state.base}`,
      '',
      '## Dependency Flow',
      deps.length > 0 ? deps : '(none)',
      '',
      '## Scope Map',
      scopes.length > 0 ? scopes : '(none)',
      '',
    ].join('\n');
    await writeFile(this.abs(MISSIONS_INDEX), content, 'utf8');
  }

  private async renderMissionFile(mission: TowerMission): Promise<void> {
    const rel = join(MISSIONS_DIR, missionFileName(mission.id, mission.slug));
    const content = [
      `# Mission ${mission.id}: ${mission.title}${mission.kind === 'survey' ? ' 🔍 (read-only survey)' : ''}`,
      '',
      '<!-- Generated by tower tools from state.json — update via the TowerMission tool. -->',
      '',
      '| Branch | Worktree | Status | Scope | Owner |',
      '| ------ | -------- | ------ | ----- | ----- |',
      `| ${mission.branch} | ${mission.worktree} | ${STATUS_EMOJI[mission.status]} | ${mission.scope.join(', ')} | ${mission.owner ?? '—'} |`,
      '',
      ...(mission.context !== undefined
        ? ['## Context — the user\'s own words, verbatim', '', mission.context, '']
        : []),
      '## Tasks',
      ...(mission.tasks.length > 0
        ? mission.tasks.map(
            (t) =>
              `- [${t.done ? 'x' : t.dropped === true ? '-' : ' '}] ${t.text}${t.dropped === true ? ' (dropped)' : ''}`,
          )
        : ['- [ ] (no tasks recorded)']),
      '',
      '## Dependencies',
      mission.deps.length > 0 ? mission.deps.join(', ') : '(none)',
      '',
      '## Blockers',
      ...(mission.blockers.length > 0 ? mission.blockers.map((b) => `- ${b}`) : ['- (none)']),
      '',
      '## Notes',
      ...(mission.notes.length > 0 ? mission.notes.map((n) => `- ${n}`) : ['- (none)']),
      '',
    ].join('\n');
    await writeFile(this.abs(rel), content, 'utf8');
  }

  abs(rel: string): string {
    return join(this.repoRoot, rel);
  }

  private async writeUnique(rel: string, content: string): Promise<string> {
    const dot = rel.lastIndexOf('.');
    const stem = dot === -1 ? rel : rel.slice(0, dot);
    const ext = dot === -1 ? '' : rel.slice(dot);
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = attempt === 0 ? rel : `${stem}-${attempt + 1}${ext}`;
      try {
        const handle = await open(this.abs(candidate), 'wx');
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new TowerProtocolError(`could not create a unique file for ${rel}`);
  }
}

function reviewDocumentBody(input: TowerReviewInput): string {
  const checks = (input.checks ?? []).map((check) => `- [x] ${check}`).join('\n');
  return [
    '## Findings',
    '',
    input.findings.trim(),
    '',
    '## Checks',
    checks.length > 0 ? checks : '- [x] (reviewer reported no formal checks)',
    '',
    '## Decision',
    input.decision.trim(),
  ].join('\n');
}

async function readGitDir(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(raw.trim());
    if (match?.[1] !== undefined) return match[1];
    return null;
  } catch {
    return null;
  }
}
