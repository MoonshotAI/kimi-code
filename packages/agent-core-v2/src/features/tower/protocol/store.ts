/**
 * `tower` domain (protocol) — `TowerStore`, the code-enforced half of the
 * tower protocol.
 *
 * Every comms artifact (inbox message, finding, review, mission file,
 * MISSIONS.md, activity log line) is produced HERE, never by an agent writing
 * files by hand. That is what makes the protocol invariants actual
 * invariants: file naming, frontmatter shape, recipient validity, review
 * rounds, the merge gate, and the exact activity-log format are not subject
 * to model discipline.
 *
 * State lives in `.tower/comms/state.json` (machine truth). `MISSIONS.md`
 * and `missions/*.md` are regenerated human views after every mutation.
 * All store instances in the process share one activity log via append-only
 * `fs.appendFile` — one line per action, written immediately.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import picomatch from 'picomatch';

import { parseFrontmatter, renderFrontmatter } from './frontmatter';
import {
  branchExists,
  branchTip,
  currentBranch,
  diffNameOnly,
  hasAnyCommit,
  isInsideRepo,
  isWorktreeDirty,
  mergeNoFf,
  worktreeAdd,
  worktreeRemove,
} from './git';
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
  WORKTREES_DIR,
  dateDash,
  findingFileName,
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

export interface TowerInitResult {
  readonly base: string;
  readonly created: boolean;
  /**
   * Roster names retired while adopting a workspace last driven by a
   * different session. Empty on creation and on same-session re-init.
   */
  readonly retiredAgents: readonly string[];
}

export interface TowerPlanInput {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tasks?: readonly string[];
  readonly deps?: readonly string[];
  /** Defaults to `build`. `survey` missions are read-only and reserve no scope. */
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

export interface TowerMissionPatch {
  readonly status?: TowerMissionStatus;
  readonly note?: string;
  readonly blocker?: string;
  readonly clearBlockers?: boolean;
  readonly taskDone?: string;
  /** Tower-only: assign the roster agent that owns this mission. */
  readonly owner?: string;
  /** Tower-only: replace the mission's scope globs (logged; widens the merge gate). */
  readonly scope?: readonly string[];
}

const FINDING_TYPES: readonly TowerFindingType[] = ['bug', 'improve', 'vuln', 'idea'];
const STATUS_EMOJI: Record<TowerMissionStatus, string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
};

export class TowerStore {
  /** Absolute path of the main checkout (the session working directory). */
  constructor(readonly repoRoot: string) {}

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create the `.tower/` skeleton. Safe to call twice — an existing
   * workspace is reported, never reset. When the existing workspace was last
   * driven by a *different* session it is adopted instead: roster entries the
   * current session did not spawn are retired (engine agent ids are
   * session-scoped, so after a restart the dead entries would alias this
   * session's freshly issued `agent-N` ids), missions/worktrees survive, and
   * an `adopt` line marks the session boundary in the activity log.
   */
  async init(sessionId?: string): Promise<TowerInitResult> {
    if (!(await isInsideRepo(this.repoRoot))) {
      throw new TowerProtocolError(
        'tower needs a git repository (the session working directory is not inside one)',
      );
    }
    if (!(await hasAnyCommit(this.repoRoot))) {
      throw new TowerProtocolError(
        'the repository has no commits yet — create an initial commit first',
      );
    }
    if (await this.isInitialized()) {
      const state = await this.load();
      const retiredAgents = await this.adoptForeignRoster(state, sessionId);
      return { base: state.base, created: false, retiredAgents };
    }

    for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
      await mkdir(this.abs(dir), { recursive: true });
    }
    await this.ensureGitExclude();

    const base = await currentBranch(this.repoRoot);
    const state: TowerState = {
      version: 1,
      base,
      mode: 'branch',
      createdAt: new Date().toISOString(),
      sessionId,
      roster: { agents: [] },
      missions: [],
    };
    await this.save(state);
    await writeFile(this.abs(ACTIVITY_LOG), '', 'utf8');
    await this.renderMissionsIndex(state);
    await this.appendLog(TOWER_NAME, 'init', { mode: state.mode, base }, MISSIONS_INDEX);
    return { base, created: true, retiredAgents: [] };
  }

  /**
   * Retire roster entries spawned by other sessions and restamp the state
   * with the current session id. The `adopt` log line is written on every
   * session change — even with nothing to retire — so id collisions across
   * the boundary stay attributable when reading the activity log.
   */
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

  /** Add `.tower/` to `.git/info/exclude` (repo-local; tracked .gitignore stays untouched). */
  private async ensureGitExclude(): Promise<void> {
    const gitDir = (await readGitDir(this.repoRoot)) ?? join(this.repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
      // no exclude file yet
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === '.tower/')) return;
    await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}.tower/\n`, 'utf8');
  }

  async load(): Promise<TowerState> {
    let raw: string;
    try {
      raw = await readFile(this.abs(STATE_FILE), 'utf8');
    } catch {
      throw new TowerProtocolError(
        'tower is not initialized in this repository — run TowerInit first',
      );
    }
    const state = JSON.parse(raw) as TowerState;
    // Backward compat: state files written before mission kinds existed are all builds.
    for (const mission of state.missions) {
      mission.kind ??= 'build';
    }
    return state;
  }

  private async save(state: TowerState): Promise<void> {
    const file = this.abs(STATE_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  // ---------------------------------------------------------------------
  // Activity log — the ONLY writer of activity.log lines.
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Roster
  // ---------------------------------------------------------------------

  resolveCallerName(state: TowerState, agentId: string): string {
    if (agentId === 'main') return TOWER_NAME;
    const entry = state.roster.agents.find((agent) => agent.agentId === agentId);
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

  /**
   * Register a spawned agent. Returns the existing entry when the name is
   * already taken — callers implement "resume instead of duplicate spawn".
   */
  findByName(state: TowerState, name: string): TowerRosterEntry | undefined {
    return this.findAgent(state, name);
  }

  async registerAgent(entry: TowerRosterEntry): Promise<void> {
    const state = await this.load();
    if (this.findAgent(state, entry.name) !== undefined) {
      throw new TowerProtocolError(`tower agent name "${entry.name}" is already registered`);
    }
    state.roster.agents.push(entry);
    await this.save(state);
  }

  // ---------------------------------------------------------------------
  // Missions
  // ---------------------------------------------------------------------

  async plan(input: readonly TowerPlanInput[]): Promise<readonly TowerMission[]> {
    if (input.length === 0) {
      throw new TowerProtocolError('TowerPlan needs at least one mission');
    }
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
        deps: item.deps ?? [],
        status: 'planned',
        tasks: (item.tasks ?? []).map((text) => ({ text, done: false })),
        notes: [],
        blockers: [],
      };
    });

    // Mission ids referenced by deps must exist (already planned or in this batch).
    const knownIds = new Set([...state.missions.map((m) => m.id), ...missions.map((m) => m.id)]);
    for (const mission of missions) {
      for (const dep of mission.deps) {
        if (!knownIds.has(dep)) {
          throw new TowerProtocolError(`mission ${mission.id} depends on unknown mission "${dep}"`);
        }
      }
    }
    // Merged missions are history, not reservations: their scopes stay on
    // record but must not block new missions from taking the same paths.
    this.assertScopesDisjoint([
      ...state.missions.filter((m) => m.status !== 'merged'),
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
  }

  /**
   * Conservative overlap check over the scopes that reserve write access —
   * i.e. `build` missions only. Survey scopes are informational and reserve
   * nothing, so they never conflict. Two build scopes conflict when one is a
   * path prefix of the other after stripping trailing `**` / `*` wildcards.
   */
  private assertScopesDisjoint(missions: readonly TowerMission[]): void {
    const scopes: Array<{ readonly id: string; readonly raw: string; readonly stem: string }> = [];
    for (const mission of missions) {
      if (mission.kind === 'survey') continue;
      for (const raw of mission.scope) {
        const stem = raw.replace(/\/\*\*?$/, '').replace(/\*$/, '').replace(/\/+$/, '');
        if (stem.length === 0) {
          throw new TowerProtocolError(
            `mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`,
          );
        }
        scopes.push({ id: mission.id, raw, stem });
      }
    }
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const a = scopes[i]!;
        const b = scopes[j]!;
        if (a.id === b.id) continue;
        if (a.stem === b.stem || a.stem.startsWith(`${b.stem}/`) || b.stem.startsWith(`${a.stem}/`)) {
          throw new TowerProtocolError(
            `mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") — split the shared files into exactly one mission`,
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
    const state = await this.load();
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

    // No-op patches (an unchanged status, nothing else) neither render nor
    // log — e.g. a worker re-declaring `active` after the tower already set it.
    const isNoOp =
      patch.status === mission.status &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDone === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined;
    if (isNoOp) return mission;

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
      this.assertScopesDisjoint([
        ...state.missions.filter((m) => m.id !== id && m.status !== 'merged'),
        { ...mission, scope: [...patch.scope] },
      ]);
      mission.scope = [...patch.scope];
    }
    if (patch.status !== undefined) mission.status = patch.status;
    if (patch.note !== undefined) mission.notes.push(patch.note);
    if (patch.blocker !== undefined) {
      mission.blockers.push(patch.blocker);
      mission.status = 'blocked';
    }
    if (patch.clearBlockers === true) mission.blockers = [];
    if (patch.taskDone !== undefined) {
      const task = mission.tasks.find((t) => !t.done && t.text.includes(patch.taskDone!));
      if (task === undefined) {
        throw new TowerProtocolError(
          `mission ${id} has no open task matching "${patch.taskDone}"`,
        );
      }
      task.done = true;
    }

    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    // Task ticks alone are not log-worthy: the mission file is their record.
    // The activity log keeps state transitions and decision-shaped changes.
    const taskTickOnly =
      patch.taskDone !== undefined &&
      patch.status === undefined &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined;
    if (!taskTickOnly && options.silent !== true) {
      await this.appendLog(callerName, 'mission.update', {
        id,
        status: patch.status,
        note: patch.note !== undefined ? 'added' : undefined,
        blocker: patch.blocker !== undefined ? 'added' : undefined,
        owner: patch.owner,
        scope: patch.scope?.join(','),
      });
    }
    return mission;
  }

  // ---------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------

  async send(callerName: string, input: TowerSendInput): Promise<string> {
    const state = await this.load();
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

    const frontmatter = renderFrontmatter({
      type: 'inbox',
      message_id: randomUUID(),
      from: callerName,
      to,
      subject: input.subject,
      sent_at: new Date().toISOString(),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.consentRef !== undefined ? { consent_ref: input.consentRef } : {}),
    });
    const content = `${frontmatter}\n\n${input.body.trim()}\n`;
    const baseName = inboxFileName({ from: callerName, to, subject: input.subject });
    const rel = await this.writeUnique(join(INBOX_DIR, baseName), content);
    await this.appendLog(callerName, 'inbox.send', { to, subject: slugify(input.subject) }, rel);
    return rel;
  }

  /** Newest-first messages addressed to `callerName` or broadcast. The tower sees everything. */
  async readInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
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
      const to = fields['to'] ?? '';
      if (callerName !== TOWER_NAME && to !== callerName && to !== BROADCAST_NAME) continue;
      items.push({
        file: rel,
        from: fields['from'] ?? 'unknown',
        to,
        subject: fields['subject'] ?? '',
        sentAt: fields['sent_at'] ?? '',
        scope: fields['scope'],
        action: fields['action'],
        consentRef: fields['consent_ref'],
        body,
      });
    }
    items.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    // Reads are not actions — the activity log records what participants DID,
    // not what they looked at. No inbox.read line here.
    return items.slice(0, Math.max(1, limit));
  }

  // ---------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------

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
    await this.appendLog(callerName, 'finding.file', { type: input.type, slug: slugify(input.title) }, rel);
    return rel;
  }

  // ---------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------

  async submitReview(callerName: string, input: TowerReviewInput): Promise<string> {
    const state = await this.load();
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'reviewer' || caller.reviewTarget !== input.target) {
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
    const myRounds = existing.filter((r) => r.reviewer === callerName).length;
    const round = myRounds + 1;
    const reviewedCommit = await branchTip(this.repoRoot, input.target);

    const frontmatter = renderFrontmatter({
      date: dateDash(),
      reviewer: callerName,
      target: input.target,
      round: String(round),
      status: input.status,
      merge: input.merge,
      reviewed_commit: reviewedCommit,
    });
    const checks = (input.checks ?? []).map((c) => `- [x] ${c}`).join('\n');
    const content = [
      frontmatter,
      '',
      '## Findings',
      '',
      input.findings.trim(),
      '',
      '## Checks',
      checks.length > 0 ? checks : '- [x] (reviewer reported no formal checks)',
      '',
      '## Decision',
      input.decision.trim(),
      '',
    ].join('\n');

    const rel = await this.writeUnique(
      join(REVIEWS_DIR, reviewFileName({ target: input.target, reviewer: callerName, round })),
      content,
    );
    await this.appendLog(
      callerName,
      'review.write',
      { target: input.target, round, verdict: input.status, reviewed: reviewedCommit.slice(0, 7) },
      rel,
    );
    return rel;
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
      reviews.push({
        reviewer: fields['reviewer'] ?? 'unknown',
        target: fields['target'] ?? target,
        round,
        status: fields['status'] ?? '',
        merge: fields['merge'] ?? '',
        reviewedCommit: fields['reviewed_commit'] ?? '',
        date: fields['date'] ?? '',
        file: rel,
      });
    }
    reviews.sort((a, b) => a.round - b.round);
    return reviews;
  }

  async latestReview(target: string): Promise<TowerReviewInfo | undefined> {
    const reviews = await this.reviewsFor(target);
    return reviews.at(-1);
  }

  // ---------------------------------------------------------------------
  // Merge — the hard gate. The tower LLM decides WHEN to call this; the
  // gate itself decides WHETHER it happens.
  // ---------------------------------------------------------------------

  async merge(branch: string): Promise<{
    readonly mergeCommit: string;
    readonly conflictsWith: ReadonlyArray<{ readonly branch: string; readonly files: readonly string[] }>;
    /** True when a read-only survey closed without a git merge. */
    readonly noop?: boolean;
  }> {
    const state = await this.load();
    const mission = state.missions.find((m) => m.branch === branch);
    if (mission === undefined) {
      throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
    }
    // A blocked merge is a decision with a reason — it belongs in the
    // activity log just as much as a successful one.
    const block = async (reason: string, message: string): Promise<TowerProtocolError> => {
      await this.appendLog(TOWER_NAME, 'merge.blocked', { branch, reason });
      return new TowerProtocolError(message);
    };

    const unmergedDeps = mission.deps.filter((dep) => {
      const depMission = state.missions.find((m) => m.id === dep);
      return depMission !== undefined && depMission.status !== 'merged';
    });
    if (unmergedDeps.length > 0) {
      throw await block(
        'deps-unmerged',
        `merge blocked: dependencies not merged yet (${unmergedDeps.join(', ')}) — merge in Dependency Flow order`,
      );
    }

    // Survey missions are read-only: a clean (zero-diff) branch closes with a
    // noop merge — no review, no git ceremony. Any change on the branch is a
    // read-only violation the tower must investigate.
    if (mission.kind === 'survey') {
      const changed = await diffNameOnly(this.repoRoot, state.base, branch);
      if (changed.length > 0) {
        throw await block(
          'read-only-survey',
          `merge blocked: survey mission ${mission.id} is read-only but ${branch} has ${String(changed.length)} changed file(s): ${changed.slice(0, 5).join(', ')} — investigate the worker; if the changes are worth keeping, move them onto a build mission's branch`,
        );
      }
      mission.status = 'merged';
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      const tip = await branchTip(this.repoRoot, state.base);
      await this.appendLog(TOWER_NAME, 'merge.noop', { branch, kind: 'survey' });
      return { mergeCommit: tip, conflictsWith: [], noop: true };
    }

    const review = await this.latestReview(branch);
    if (review === undefined) {
      throw await block(
        'no-review',
        `merge blocked: ${branch} has no review — assign a reviewer first`,
      );
    }
    if (review.status !== 'clean') {
      throw await block(
        'not-clean',
        `merge blocked: latest review (round ${review.round} by ${review.reviewer}) is "${review.status}" — a clean round is required`,
      );
    }
    const tip = await branchTip(this.repoRoot, branch);
    if (review.reviewedCommit !== tip) {
      throw await block(
        'tip-moved',
        `merge blocked: ${branch} moved since the clean review (reviewed ${review.reviewedCommit.slice(0, 7)}, tip ${tip.slice(0, 7)}) — re-review required`,
      );
    }

    // Scope isolation, enforced: every file the branch changed must fall
    // inside the mission's declared scope globs (picomatch semantics — `**`
    // crosses directories). A legitimate expansion goes through a tower
    // TowerMission scope update first, which is logged.
    const changed = await diffNameOnly(this.repoRoot, state.base, branch);
    const outOfScope = changed.filter(
      (file) => !mission.scope.some((glob) => picomatch.isMatch(file, glob)),
    );
    if (outOfScope.length > 0) {
      throw await block(
        'out-of-scope',
        `merge blocked: ${branch} changed files outside mission ${mission.id} scope (${mission.scope.join(', ')}): ${outOfScope.join(', ')} — the tower must widen the mission scope (TowerMission scope patch) or revert those changes`,
      );
    }

    // The merge lands wherever the main checkout currently points: refuse
    // when it has moved off the recorded base since TowerInit (a hotfix
    // branch, a detached HEAD) — otherwise the mission would be marked
    // merged while the base branch never received it.
    let checkedOut: string;
    try {
      checkedOut = await currentBranch(this.repoRoot);
    } catch {
      throw await block(
        'base-mismatch',
        `merge blocked: the main checkout is in a detached HEAD state — check out the recorded base branch "${state.base}" before merging; nothing was merged`,
      );
    }
    if (checkedOut !== state.base) {
      throw await block(
        'base-mismatch',
        `merge blocked: the main checkout is on "${checkedOut}", not the recorded base "${state.base}" — switch it back (\`git checkout ${state.base}\`) and retry; nothing was merged`,
      );
    }

    const mergeCommit = await mergeNoFf(this.repoRoot, branch);
    mission.status = 'merged';

    // Informational: unmerged branches that touched the same files now likely
    // conflict with the new base. The tower tells them to rebase — their tip
    // moves, and the reviewed_commit gate then forces a re-review.
    const changedSet = new Set(changed);
    const conflictsWith: Array<{ readonly branch: string; readonly files: readonly string[] }> = [];
    for (const other of state.missions) {
      if (other.branch === branch || other.status === 'merged') continue;
      // Planned missions may have no branch yet (never spawned) — nothing to conflict with.
      if (!(await branchExists(this.repoRoot, other.branch))) continue;
      const otherChanged = await diffNameOnly(this.repoRoot, state.base, other.branch);
      const overlap = otherChanged.filter((file) => changedSet.has(file));
      if (overlap.length > 0) {
        conflictsWith.push({ branch: other.branch, files: overlap });
      }
    }

    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    await this.appendLog(TOWER_NAME, 'merge', { branch, base: state.base, merge_commit: mergeCommit.slice(0, 7) });
    return { mergeCommit, conflictsWith };
  }

  // ---------------------------------------------------------------------
  // Worktrees / teardown
  // ---------------------------------------------------------------------

  async addWorktree(worktree: string, branch: string, base: string): Promise<string> {
    const rel = join(WORKTREES_DIR, worktree);
    await worktreeAdd(this.repoRoot, this.abs(rel), branch, base);
    await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base });
    return rel;
  }

  async teardown(options: { readonly force?: boolean } = {}): Promise<readonly string[]> {
    const state = await this.load();
    const report: string[] = [];
    for (const mission of state.missions) {
      const rel = join(WORKTREES_DIR, mission.worktree);
      const absPath = this.abs(rel);
      if (await isWorktreeDirty(absPath)) {
        if (options.force !== true) {
          report.push(`kept ${rel} (uncommitted changes — rerun with force to remove)`);
          await this.appendLog(TOWER_NAME, 'worktree.keep', {
            worktree: mission.worktree,
            reason: 'uncommitted-changes',
          });
          continue;
        }
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
    await this.appendLog(TOWER_NAME, 'teardown', { force: options.force === true ? 'yes' : undefined });
    return report;
  }

  // ---------------------------------------------------------------------
  // Human views (generated, never hand-edited)
  // ---------------------------------------------------------------------

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
      'Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged',
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
      '## Tasks',
      ...(mission.tasks.length > 0
        ? mission.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`)
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

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  abs(rel: string): string {
    return join(this.repoRoot, rel);
  }

  /** Exclusive-create write; on a name clash appends `-2`, `-3`, … before the extension. */
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

/** Locate the real git dir (a worktree's `.git` is a file pointing elsewhere). */
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
