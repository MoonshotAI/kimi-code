/**
 * S1+S2 — session-scoped human-in-the-loop services over the Rust engine.
 *
 * `sessionApprovalService` is fully engine-backed: pending approvals are the
 * engine's deferred tool approvals (`sessionApprovalList`) and `decide` feeds
 * the decision back through `sessionApprovalResolve` (the same store the
 * `authorize_tool_execution` callback and the web approval cards share).
 *
 * `sessionInteractionService` synthesizes the retired interaction kernel's
 * pending set from the two engine surfaces that map onto `InteractionKind`:
 *   - `approval` ← `sessionApprovalList(sessionId).pending`
 *   - `question` ← the engine's background question tasks (`bgList()`, kind
 *     `question`, status `running`); `respond` settles the task with the
 *     rendered answer (`bgAppendOutput` + `bgSettle`)
 *   - `user_tool` ← no engine surface (the engine delegates AskUserQuestion /
 *     interactive tools to the host's `execute_tool` callback, which the
 *     klient channel has not wired), so it is always empty.
 * `isRecentlyResolved` mirrors the v2 kernel's 60s/256-entry ring buffer.
 *
 * `sessionQuestionService` mirrors `sessionApprovalService` against the
 * question-task roster: `listPending` surfaces pending `question` tasks and
 * `answer`/`dismiss` settle them. The engine exposes no `sessionQuestion*`
 * RPC and no question reverse-callback (rust-loop wires only llm/tool/event
 * handlers), so the full `QuestionItem` option set is not queryable — each
 * pending request carries a single synthesized item with the task's
 * description as the question text (the engine's `question_description`
 * already renders "first question (+N more)").
 *
 * Engine note: the question pool reads `bg/*` (BackgroundManager), not
 * `task/list` (TaskService) — the two registries are separate and the
 * TaskService is registry-only on the RPC surface today, so nothing a
 * session can reach creates tasks there.
 */

import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';
import { RPCError } from '../../../core/errors.js';

// ── Recently-resolved ring buffer (v2 kernel parity) ────────────────────────
// agent-core-v2/src/session/interaction/interactionService.ts:
// RECENTLY_RESOLVED_TTL_MS = 60_000, RECENTLY_RESOLVED_MAX = 256.

const RECENTLY_RESOLVED_TTL_MS = 60_000;
const RECENTLY_RESOLVED_MAX = 256;
const recentlyResolved = new Map<string, number>();

function rememberResolved(id: string): void {
  const now = Date.now();
  for (const [key, resolvedAt] of recentlyResolved) {
    if (now - resolvedAt > RECENTLY_RESOLVED_TTL_MS) recentlyResolved.delete(key);
  }
  while (recentlyResolved.size >= RECENTLY_RESOLVED_MAX) {
    const oldest = recentlyResolved.keys().next().value;
    if (oldest === undefined) break;
    recentlyResolved.delete(oldest);
  }
  recentlyResolved.set(id, now);
}

function isRecentlyResolvedId(id: string): boolean {
  const resolvedAt = recentlyResolved.get(id);
  if (resolvedAt === undefined) return false;
  if (Date.now() - resolvedAt > RECENTLY_RESOLVED_TTL_MS) {
    recentlyResolved.delete(id);
    return false;
  }
  return true;
}

// ── Session-scope guard ─────────────────────────────────────────────────────

/** The interaction/question/approval services are session-scoped. */
function requireSession(ctx: RustCallContext): string {
  const sessionId = ctx.scope.sessionId;
  if (sessionId === undefined || sessionId.length === 0) {
    throw new RPCError(40001, 'sessionInteractionService requires a session scope');
  }
  return sessionId;
}

// ── Approval mapping (engine web approval surface) ─────────────────────────

interface EngineApprovalEntryLike {
  id: string;
  session_id?: string | null;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  approval_rule: string;
  created_at_ms: number;
}

interface ApprovalRequestLike {
  id: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  action: string;
  display: { kind: 'generic'; summary: string; detail?: unknown };
}

/** Map an engine approval entry onto the v2 `ApprovalRequest` shape. The
 *  `display` mirrors the node-sdk's authorize callback (`kind: 'generic'`
 *  with the tool name + arguments as the detail). */
function toApprovalRequest(entry: EngineApprovalEntryLike, sessionId: string): ApprovalRequestLike {
  const request: ApprovalRequestLike = {
    id: entry.id,
    toolName: entry.tool_name,
    action: entry.tool_name,
    display: { kind: 'generic', summary: entry.tool_name, detail: entry.arguments },
  };
  if (entry.session_id !== undefined && entry.session_id !== null && entry.session_id.length > 0) {
    request.sessionId = entry.session_id;
  } else {
    request.sessionId = sessionId;
  }
  if (entry.tool_call_id.length > 0) request.toolCallId = entry.tool_call_id;
  return request;
}

/** Resolve one pending approval; `resolved` false = unknown id (no-op). */
async function resolveApproval(
  ctx: RustCallContext,
  sessionId: string,
  id: string,
  response: unknown,
): Promise<boolean> {
  const decision = (response as { decision?: string } | null)?.decision;
  const feedback = (response as { feedback?: string } | null)?.feedback;
  const selectedLabel = (response as { selectedLabel?: string } | null)?.selectedLabel;
  const result = await ctx.rust.sessionApprovalResolve(sessionId, {
    id,
    decision: decision === 'approved' ? 'allow' : 'deny',
    reason: feedback ?? selectedLabel,
  });
  return result?.resolved === true;
}

async function listApprovalEntries(ctx: RustCallContext): Promise<EngineApprovalEntryLike[]> {
  const result = await ctx.rust.sessionApprovalList(requireSession(ctx));
  return (result?.pending ?? []) as EngineApprovalEntryLike[];
}

// ── Question-task mapping (engine background `question` tasks) ──────────────

/** Wire shape of a `question`-kind background task (`bg/*`, BackgroundManager).
 *  The engine serializes the untagged `BackgroundTaskInfo` union with the
 *  shared fields nested under `base`. */
interface BgQuestionTaskWire {
  base?: {
    task_id?: string;
    description?: string;
    status?: string;
    started_at?: number;
    ended_at?: number | null;
  };
  kind?: string;
  question_count?: number;
  tool_call_id?: string;
}

interface QuestionRequestLike {
  id: string;
  toolCallId?: string;
  questions: Array<{ question: string; options: Array<{ label: string }> }>;
}

function isPendingQuestionTask(task: unknown): task is BgQuestionTaskWire {
  const wire = (task ?? {}) as BgQuestionTaskWire;
  return wire.kind === 'question' && wire.base?.status === 'running';
}

function questionTaskId(task: BgQuestionTaskWire): string {
  return task.base?.task_id ?? '';
}

/** The engine's `question_description`: the first question's text, `(+N more)`
 *  past one — already the human-readable label of the task. */
function questionDescription(task: BgQuestionTaskWire): string {
  return task.base?.description ?? '';
}

function toQuestionRequest(task: BgQuestionTaskWire): QuestionRequestLike {
  const request: QuestionRequestLike = {
    id: questionTaskId(task),
    questions: [{ question: questionDescription(task), options: [] }],
  };
  if (task.tool_call_id !== undefined && task.tool_call_id !== null && task.tool_call_id.length > 0) {
    request.toolCallId = task.tool_call_id;
  }
  return request;
}

/** Render a `QuestionResult` the way the engine's `render_question_result`
 *  does: null (or empty answers) → dismissed note, `{answers}` / bare answers
 *  map → `{"answers": {...}}`. */
function renderQuestionResult(result: unknown): string {
  const dismissed = { answers: {}, note: 'User dismissed the question without answering.' };
  if (result === null || result === undefined) return JSON.stringify(dismissed);
  if (typeof result !== 'object') return JSON.stringify(dismissed);
  const object = result as Record<string, unknown>;
  const answers =
    typeof object['answers'] === 'object' &&
    object['answers'] !== null &&
    !Array.isArray(object['answers'])
      ? object['answers']
      : object;
  if (Object.keys(answers as object).length === 0) return JSON.stringify(dismissed);
  return JSON.stringify({ answers });
}

async function listQuestionTasks(ctx: RustCallContext): Promise<BgQuestionTaskWire[]> {
  const tasks = await ctx.rust.bgList();
  return ((tasks ?? []) as unknown[]).filter(isPendingQuestionTask);
}

/** Deliver a question answer by settling the pending background task. Unknown
 *  ids are a v2-parity no-op (the kernel's `respond` on a missing id). */
async function settleQuestionTask(
  ctx: RustCallContext,
  task: BgQuestionTaskWire,
  result: unknown,
): Promise<void> {
  const taskId = questionTaskId(task);
  if (taskId.length === 0) return;
  await ctx.rust.bgAppendOutput(taskId, renderQuestionResult(result));
  await ctx.rust.bgSettle(taskId, 'completed');
}

// ── Service registries ──────────────────────────────────────────────────────

/** `sessionApprovalService` — pending approvals + decide (engine-backed). */
export const sessionApprovalService: RustServiceRegistry = {
  async listPending(ctx) {
    const sessionId = requireSession(ctx);
    const entries = await listApprovalEntries(ctx);
    return entries.map((entry) => toApprovalRequest(entry, sessionId));
  },

  async decide(ctx) {
    const sessionId = requireSession(ctx);
    const [id, response] = ctx.args as [string, { decision?: string; feedback?: string; selectedLabel?: string }];
    if (await resolveApproval(ctx, sessionId, id, response)) rememberResolved(id);
    return undefined;
  },
};

/** `sessionQuestionService` — pending question tasks + answer/dismiss. */
export const sessionQuestionService: RustServiceRegistry = {
  async listPending(ctx) {
    const tasks = await listQuestionTasks(ctx);
    return tasks.map(toQuestionRequest);
  },

  async answer(ctx) {
    const [id, result] = ctx.args as [string, unknown];
    const task = (await listQuestionTasks(ctx)).find((t) => questionTaskId(t) === id);
    if (task === undefined) return undefined; // v2 parity: unknown id no-ops
    await settleQuestionTask(ctx, task, result);
    rememberResolved(id);
    return undefined;
  },

  async dismiss(ctx) {
    const [id] = ctx.args as [string];
    const task = (await listQuestionTasks(ctx)).find((t) => questionTaskId(t) === id);
    if (task === undefined) return undefined; // v2 parity: unknown id no-ops
    await settleQuestionTask(ctx, task, null);
    rememberResolved(id);
    return undefined;
  },
};

/** `sessionInteractionService` — the pending interaction kernel view. */
export const sessionInteractionService: RustServiceRegistry = {
  async listPending(ctx) {
    const kind = ctx.args[0] as 'approval' | 'question' | 'user_tool' | undefined;
    const sessionId = requireSession(ctx);
    const all: Array<{
      id: string;
      kind: 'approval' | 'question';
      payload: unknown;
      origin: { agentId?: string; turnId?: number };
      createdAt: number;
    }> = [];
    for (const entry of await listApprovalEntries(ctx)) {
      all.push({
        id: entry.id,
        kind: 'approval',
        payload: toApprovalRequest(entry, sessionId),
        origin: {},
        createdAt: entry.created_at_ms,
      });
    }
    for (const task of await listQuestionTasks(ctx)) {
      all.push({
        id: questionTaskId(task),
        kind: 'question',
        payload: toQuestionRequest(task),
        origin: {},
        createdAt: task.base?.started_at ?? 0,
      });
    }
    // `user_tool` has no engine surface; the kind filter drops nothing extra.
    return kind === undefined ? all : all.filter((interaction) => interaction.kind === kind);
  },

  async respond(ctx) {
    const sessionId = requireSession(ctx);
    const [id, response] = ctx.args as [string, unknown];

    // Route by the pending interaction's kind, exactly like the v2 kernel
    // resolves the parked request.
    const approvals = await listApprovalEntries(ctx);
    if (approvals.some((entry) => entry.id === id)) {
      if (await resolveApproval(ctx, sessionId, id, response)) rememberResolved(id);
      return undefined;
    }
    const task = (await listQuestionTasks(ctx)).find((t) => questionTaskId(t) === id);
    if (task !== undefined) {
      await settleQuestionTask(ctx, task, response);
      rememberResolved(id);
      return undefined;
    }
    // Unknown id → no-op (v2 kernel parity; the entry may have resolved
    // between list and respond).
    return undefined;
  },

  async isRecentlyResolved(ctx) {
    const [id] = ctx.args as [string];
    return isRecentlyResolvedId(id);
  },
};

registerService('sessionApprovalService', sessionApprovalService);
registerService('sessionQuestionService', sessionQuestionService);
registerService('sessionInteractionService', sessionInteractionService);
