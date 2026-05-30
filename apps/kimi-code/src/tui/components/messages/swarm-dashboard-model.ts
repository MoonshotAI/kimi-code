export type SwarmPhase = 'planning' | 'working' | 'synthesizing' | 'done' | 'cancelled' | 'failed';
export type WorkerStatus = 'running' | 'done' | 'failed' | 'retrying' | 'dropped';

export interface WorkerRow {
  id: string;
  role: string;
  status: WorkerStatus;
  toolCount: number;
  latestActivity?: string;
  tokens?: number;
  error?: string;
}

export interface SwarmModel {
  task: string;
  phase: SwarmPhase;
  total: number;
  doneCount: number;
  failedCount: number;
  droppedCount: number;
  workers: Map<string, WorkerRow>;
  /** Set when phase is 'failed': the reason the whole swarm errored out. */
  failureMessage?: string;
}

export type SwarmEvent =
  | { t: 'planned'; total: number }
  | { t: 'synthesizing' }
  | { t: 'done'; succeeded: number; failed: number }
  | { t: 'cancelled' }
  | { t: 'failed'; message: string }
  | { t: 'worker.spawned'; id: string; role: string }
  | { t: 'worker.toolcall'; id: string; activity: string }
  | { t: 'worker.tokens'; id: string; tokens: number }
  | { t: 'worker.done'; id: string; tokens?: number }
  | { t: 'worker.failed'; id: string; error: string }
  | { t: 'worker.retrying'; role: string }
  | { t: 'worker.reassigned'; fromRole: string; toRole: string }
  | { t: 'worker.dropped'; role: string; reason: string };

export function initialSwarmModel(task: string): SwarmModel {
  return {
    task,
    phase: 'planning',
    total: 0,
    doneCount: 0,
    failedCount: 0,
    droppedCount: 0,
    workers: new Map(),
  };
}

/**
 * Which summary counter (if any) a worker status contributes to. `running` and
 * `retrying` are in-flight states that count toward nothing; the three terminal
 * states each map to exactly one counter. Used to keep `doneCount`/
 * `failedCount`/`droppedCount` consistent as a row transitions across attempts
 * (e.g. failed → retrying → running → done) without ever double-counting.
 */
function countKeyFor(status: WorkerStatus): 'doneCount' | 'failedCount' | 'droppedCount' | null {
  if (status === 'done') return 'doneCount';
  if (status === 'failed') return 'failedCount';
  if (status === 'dropped') return 'droppedCount';
  // 'running' and 'retrying' are in-flight states — they count toward nothing.
  return null;
}

/** Counter adjustments to move a row from `prev` to `next` status. */
function countAdjustments(
  prev: WorkerStatus,
  next: WorkerStatus,
): Partial<Pick<SwarmModel, 'doneCount' | 'failedCount' | 'droppedCount'>> {
  const from = countKeyFor(prev);
  const to = countKeyFor(next);
  if (from === to) return {};
  const adj: Partial<Pick<SwarmModel, 'doneCount' | 'failedCount' | 'droppedCount'>> = {};
  if (from !== null) adj[from] = -1;
  if (to !== null) adj[to] = (adj[to] ?? 0) + 1;
  return adj;
}

/** Apply count deltas onto a model, clamping at zero. */
function withCounts(
  model: SwarmModel,
  adj: Partial<Pick<SwarmModel, 'doneCount' | 'failedCount' | 'droppedCount'>>,
): Pick<SwarmModel, 'doneCount' | 'failedCount' | 'droppedCount'> {
  return {
    doneCount: Math.max(0, model.doneCount + (adj.doneCount ?? 0)),
    failedCount: Math.max(0, model.failedCount + (adj.failedCount ?? 0)),
    droppedCount: Math.max(0, model.droppedCount + (adj.droppedCount ?? 0)),
  };
}

/** A status the recovery loop can collapse a re-spawn onto (one row per role). */
function isReusableForRespawn(status: WorkerStatus): boolean {
  return status === 'failed' || status === 'dropped' || status === 'retrying';
}

export function applySwarmEvent(model: SwarmModel, event: SwarmEvent): SwarmModel {
  switch (event.t) {
    case 'planned':
      return { ...model, phase: 'working', total: event.total };
    case 'synthesizing':
      return { ...model, phase: 'synthesizing' };
    case 'done':
      return { ...model, phase: 'done' };
    case 'cancelled':
      return { ...model, phase: 'cancelled' };
    case 'failed':
      return { ...model, phase: 'failed', failureMessage: event.message };
    case 'worker.spawned': {
      if (model.workers.has(event.id)) return model;
      const workers = new Map(model.workers);
      // Recovery: if a row for this role exists in a terminal/retrying state, a
      // re-spawn is the SAME subtask running again. Reuse that row (re-key it to
      // the new subagent id, reset to running, clear the error) so the role keeps
      // a single dashboard row across attempts instead of accumulating duplicates.
      // Running rows are never reused, so single-run same-role fan-out is intact.
      const prior = findReusableRoleRow(model.workers, event.role);
      if (prior !== undefined) {
        workers.delete(prior.id);
        workers.set(event.id, { id: event.id, role: event.role, status: 'running', toolCount: 0 });
        return {
          ...model,
          workers,
          ...withCounts(model, countAdjustments(prior.status, 'running')),
        };
      }
      workers.set(event.id, { id: event.id, role: event.role, status: 'running', toolCount: 0 });
      return { ...model, workers };
    }
    case 'worker.toolcall': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w !== undefined) {
        workers.set(event.id, { ...w, toolCount: w.toolCount + 1, latestActivity: event.activity });
      }
      return { ...model, workers };
    }
    case 'worker.tokens': {
      const w = model.workers.get(event.id);
      if (w === undefined) return model;
      const workers = new Map(model.workers);
      workers.set(event.id, { ...w, tokens: event.tokens });
      return { ...model, workers };
    }
    case 'worker.done': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w === undefined) return model;
      workers.set(event.id, {
        ...w,
        status: 'done',
        latestActivity: undefined,
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      });
      return { ...model, workers, ...withCounts(model, countAdjustments(w.status, 'done')) };
    }
    case 'worker.failed': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w === undefined) return model;
      workers.set(event.id, { ...w, status: 'failed', latestActivity: undefined, error: event.error });
      return { ...model, workers, ...withCounts(model, countAdjustments(w.status, 'failed')) };
    }
    case 'worker.retrying': {
      // The coordinator decided to re-run this role's subtask. Keep its row
      // visible but mark it retrying (an in-flight, uncounted state) so the
      // re-spawn can collapse onto it. Carries no subagent id, so we match by
      // role against the most recent terminal/retrying row.
      const prior = findReusableRoleRow(model.workers, event.role);
      if (prior === undefined || prior.status === 'retrying') return model;
      const workers = new Map(model.workers);
      const adj = countAdjustments(prior.status, 'retrying');
      workers.set(prior.id, { ...prior, status: 'retrying', latestActivity: undefined });
      return { ...model, workers, ...withCounts(model, adj) };
    }
    case 'worker.reassigned': {
      // The reviser moved this subtask to a new role. Re-key the SAME row from
      // the old role to the new one and mark it retrying so the subsequent
      // worker.spawned for the new role reuses THIS row (one row per subtask)
      // instead of stranding the old-role row in 'retrying' forever. If no
      // old-role row exists, no-op — there is nothing to correlate.
      const prior = findReusableRoleRow(model.workers, event.fromRole);
      if (prior === undefined) return model;
      const workers = new Map(model.workers);
      const adj = countAdjustments(prior.status, 'retrying');
      workers.set(prior.id, {
        ...prior,
        role: event.toRole,
        status: 'retrying',
        latestActivity: undefined,
        error: undefined,
      });
      return { ...model, workers, ...withCounts(model, adj) };
    }
    case 'worker.dropped': {
      // The coordinator gave up on this role's subtask. Mark its row dropped
      // (or create a dropped row if the subtask never spawned a worker) and
      // record the reason.
      const prior = findReusableRoleRow(model.workers, event.role) ?? findRoleRow(model.workers, event.role);
      const workers = new Map(model.workers);
      if (prior === undefined) {
        // No row yet (dropped before ever spawning): synthesize one keyed by the
        // role so the gap is visible. A role label collides with no subagent id.
        workers.set(event.role, {
          id: event.role,
          role: event.role,
          status: 'dropped',
          toolCount: 0,
          error: event.reason,
        });
        return { ...model, workers, ...withCounts(model, countAdjustments('running', 'dropped')) };
      }
      workers.set(prior.id, { ...prior, status: 'dropped', latestActivity: undefined, error: event.reason });
      return { ...model, workers, ...withCounts(model, countAdjustments(prior.status, 'dropped')) };
    }
    default:
      return model;
  }
}

/** Most recently inserted row for a role (any status), or undefined. */
function findRoleRow(workers: Map<string, WorkerRow>, role: string): WorkerRow | undefined {
  let match: WorkerRow | undefined;
  for (const w of workers.values()) {
    if (w.role === role) match = w;
  }
  return match;
}

/**
 * Most recently inserted row for a role that a re-spawn or revise can collapse
 * onto (terminal or retrying). Running rows are skipped so concurrent same-role
 * workers in a single run keep distinct rows.
 */
function findReusableRoleRow(workers: Map<string, WorkerRow>, role: string): WorkerRow | undefined {
  let match: WorkerRow | undefined;
  for (const w of workers.values()) {
    if (w.role === role && isReusableForRespawn(w.status)) match = w;
  }
  return match;
}

export function workerActivityFromTool(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  switch (name) {
    case 'Read': {
      const p = s(args['path']);
      return p !== undefined ? `read ${p}` : 'read';
    }
    case 'Grep': {
      const p = s(args['pattern']);
      return p !== undefined ? `grep "${p}"` : 'grep';
    }
    case 'Glob': {
      const p = s(args['pattern']);
      return p !== undefined ? `glob ${p}` : 'glob';
    }
    case 'WebSearch': {
      const q = s(args['query']);
      return q !== undefined ? `search "${q}"` : 'search';
    }
    case 'FetchURL': {
      const u = s(args['url']);
      return u !== undefined ? `fetch ${u}` : 'fetch';
    }
    default:
      return name;
  }
}
