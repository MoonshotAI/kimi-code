/**
 * `agentServices` — the agent-scope domain services (A1+A2). All four are
 * engine-backed: plan / profile / shell resolve to rust-loop session RPCs
 * (the engine session surface is the session's main agent, so every method
 * routes by `scope.sessionId` and ignores `agentId`); tasks project the
 * engine's process-wide `task/list` + `bg/*` surfaces onto the v1 per-session
 * wire shape. Return shapes match `contract/agent/services.ts` exactly — the
 * facade re-validates them with zod (`parseOutput`).
 *
 * `agentShellCommandService.run` delegates to the engine's native (silent)
 * `session/run_shell`; when the native shell is unavailable the host owns the
 * `!` command (thin `child_process.exec` fallback in the session workspace).
 */

import { exec } from 'node:child_process';

import { RPCError, type RustCallContext, type RustServiceRegistry } from '../types.js';
import { registerService } from '../router.js';

import type { z } from 'zod';
import type { agentTaskInfoSchema } from '#/contract/agent/rpc';

type AgentTaskInfo = z.infer<typeof agentTaskInfoSchema>;

const SESSION_REQUIRED = 40001;

/** Agent services are session-scoped; the engine surface has no core scope. */
function requireSession(ctx: RustCallContext): string {
  const sessionId = ctx.scope.sessionId;
  if (sessionId === undefined || sessionId.length === 0) {
    throw new RPCError(SESSION_REQUIRED, 'agent service call requires a session scope');
  }
  return sessionId;
}

// ── agentPlanService ────────────────────────────────────────────────────────

export const agentPlanService: RustServiceRegistry = {
  /** Active plan snapshot (`null` when plan mode is off) — EnginePlanInfo
   *  is already the contract `{ id, content, path }` shape. */
  async status(ctx) {
    const sessionId = requireSession(ctx);
    return ctx.rust.sessionGetPlan(sessionId);
  },

  /** Enter plan mode (engine idempotent: re-entering is a no-op). */
  async enter(ctx) {
    const sessionId = requireSession(ctx);
    await ctx.rust.sessionSetPlanMode(sessionId, true);
    return undefined;
  },

  /** Exit plan mode. The optional plan id rides the wire for v2 parity but
   *  the engine's plan mode is a session toggle, so it is not consulted. */
  async cancel(ctx) {
    const sessionId = requireSession(ctx);
    await ctx.rust.sessionSetPlanMode(sessionId, false);
    return undefined;
  },

  /** Clear the active plan file's content (no-op when no plan is active). */
  async clear(ctx) {
    const sessionId = requireSession(ctx);
    await ctx.rust.sessionClearPlan(sessionId);
    return undefined;
  },
};

// ── agentProfileService ─────────────────────────────────────────────────────

export const agentProfileService: RustServiceRegistry = {
  /** The session's bound model alias (`''` when none — node-sdk parity). */
  async getModel(ctx) {
    const sessionId = requireSession(ctx);
    const status = await ctx.rust.sessionGetStatus(sessionId);
    return status?.model ?? '';
  },

  /** Switch the session model from the next turn onward. The engine RPC
   *  returns `{ ok }` only; `providerName` (optional in the contract) is
   *  omitted — deriving it would need the model catalog. */
  async setModel(ctx) {
    const sessionId = requireSession(ctx);
    const model = ctx.args[0] as string;
    await ctx.rust.sessionSetModel(sessionId, model);
    return { model };
  },
};

// ── agentShellCommandService ────────────────────────────────────────────────

const SHELL_FOREGROUND_TIMEOUT_S = 2 * 60;

/** Host-side controllers for `!` commands the engine deferred (`unavailable`),
 *  keyed by commandId so `cancel` can abort the child process. */
const hostShellControllers = new Map<string, AbortController>();

/** Resolve the session workspace for the host shell fallback. */
async function resolveSessionCwd(ctx: RustCallContext, sessionId: string): Promise<string> {
  const list = await ctx.rust.sessionList(100, 0);
  const record = list?.sessions?.find((s) => s.id === sessionId);
  return record?.work_dir ?? ctx.host.homeDir;
}

function runShellOnHost(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; isError: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: SHELL_FOREGROUND_TIMEOUT_S * 1000, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            stdout: '',
            stderr: stderr.length > 0 ? stderr : String(error.message),
            isError: true,
          });
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', isError: false });
      },
    );
  });
}

export const agentShellCommandService: RustServiceRegistry = {
  /** Run a user-initiated `!` command. The engine executes it natively
   *  (silent); `unavailable` means no native shell exists, so the host runs
   *  the command in the session workspace instead. */
  async run(ctx) {
    const sessionId = requireSession(ctx);
    const input = (ctx.args[0] ?? {}) as { command: string; commandId?: string };
    const { command, commandId } = input;

    const engineResult = await ctx.rust.sessionRunShell(
      sessionId,
      command,
      undefined,
      commandId,
    );
    if (engineResult !== null && engineResult.unavailable !== true) {
      return {
        stdout: engineResult.output ?? '',
        stderr: '',
        isError: engineResult.is_error === true,
      };
    }

    // Engine shell unavailable — the host owns the `!` command.
    const controller = new AbortController();
    if (commandId !== undefined) hostShellControllers.set(commandId, controller);
    try {
      const cwd = await resolveSessionCwd(ctx, sessionId);
      return await runShellOnHost(command, cwd, controller.signal);
    } finally {
      if (commandId !== undefined) hostShellControllers.delete(commandId);
    }
  },

  /** Cancel a streaming `!` command by commandId: abort a host-executed
   *  fallback first, then ask the engine to cancel its native run. */
  async cancel(ctx) {
    const sessionId = requireSession(ctx);
    const commandId = ctx.args[0] as string;
    hostShellControllers.get(commandId)?.abort();
    hostShellControllers.delete(commandId);
    await ctx.rust.sessionCancelShellCommand(sessionId, commandId);
    return undefined;
  },
};

// ── agentTaskService ────────────────────────────────────────────────────────

/**
 * Loose union of the engine's task wire records. `task/list` returns the flat
 * `TaskInfoBase` (kind + base fields, no variant data); `bg/list` returns the
 * rich `BackgroundTaskInfo` (variant fields at top level, base nested under
 * `base`). Both map onto the contract's `AgentTaskInfo` discriminated union.
 */
interface EngineTaskRecordLike {
  task_id?: string;
  description?: string;
  status?: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  kind?: string;
  started_at?: number;
  ended_at?: number | null;
  detached?: boolean;
  stop_reason?: string | null;
  terminal_notification_suppressed?: boolean;
  timeout_ms?: number | null;
  agent_id?: string | null;
  base?: EngineTaskRecordLike | null;
  command?: string;
  pid?: number;
  exit_code?: number | null;
  subagent_type?: string | null;
  question_count?: number;
  tool_call_id?: string | null;
}

function taskIdOf(record: EngineTaskRecordLike): string {
  return record.base?.task_id ?? record.task_id ?? '';
}

function toTaskInfo(record: EngineTaskRecordLike): AgentTaskInfo {
  const base = record.base ?? record;
  const common = {
    taskId: base.task_id ?? '',
    description: base.description ?? '',
    status: base.status ?? 'running',
    detached: base.detached,
    startedAt: base.started_at ?? 0,
    endedAt: base.ended_at ?? null,
    stopReason: base.stop_reason ?? undefined,
    terminalNotificationSuppressed: base.terminal_notification_suppressed,
    timeoutMs: base.timeout_ms ?? undefined,
  };
  switch (record.kind ?? base.kind) {
    case 'process':
      // The engine folds the process variant into the base shape (command is
      // not carried on `task/list`; `bg/*` sets command := description).
      return {
        kind: 'process',
        command: record.command ?? base.description ?? '',
        pid: record.pid ?? 0,
        exitCode: record.exit_code ?? null,
        ...common,
      };
    case 'question':
      return {
        kind: 'question',
        questionCount: record.question_count ?? 0,
        toolCallId: record.tool_call_id ?? undefined,
        ...common,
      };
    default:
      return {
        kind: 'agent',
        agentId: record.agent_id ?? base.agent_id ?? undefined,
        subagentType: record.subagent_type ?? undefined,
        ...common,
      };
  }
}

/** The engine's task rosters: `task/list` (engine TaskService) + `bg/list`
 *  (host-registered BackgroundManager), merged by task id (bg records win —
 *  they carry the variant fields). */
async function listEngineTasks(ctx: RustCallContext): Promise<AgentTaskInfo[]> {
  const [engineTasks, bgTasks] = await Promise.all([
    ctx.rust.sessionTaskList(),
    ctx.rust.bgList(),
  ]);
  const byId = new Map<string, EngineTaskRecordLike>();
  const records: EngineTaskRecordLike[] = [
    ...((engineTasks ?? []) as EngineTaskRecordLike[]),
    ...((bgTasks ?? []) as EngineTaskRecordLike[]),
  ];
  for (const record of records) {
    const id = taskIdOf(record);
    if (id.length === 0) continue;
    const existing = byId.get(id);
    if (existing === undefined || record.base !== undefined) byId.set(id, record);
  }
  return [...byId.values()].map(toTaskInfo);
}

async function findTask(
  ctx: RustCallContext,
  taskId: string,
): Promise<AgentTaskInfo | undefined> {
  const tasks = await listEngineTasks(ctx);
  return tasks.find((task) => task.taskId === taskId);
}

export const agentTaskService: RustServiceRegistry = {
  /** Full roster; `activeOnly` keeps running tasks and `limit` truncates
   *  (the engine's `task/list` is process-wide, not per-session). */
  async list(ctx) {
    requireSession(ctx);
    const [activeOnly, limit] = ctx.args as [boolean | undefined, number | undefined];
    let tasks = await listEngineTasks(ctx);
    if (activeOnly === true) {
      tasks = tasks.filter((task) => task.status === 'running');
    }
    if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  },

  /** Output preview for a task; `tail` is accepted for v2 parity (the engine
   *  returns a bounded preview regardless). Unknown tasks → `''`. */
  async readOutput(ctx) {
    requireSession(ctx);
    const taskId = ctx.args[0] as string;
    const result = await ctx.rust.bgOutput(taskId);
    return result?.preview ?? '';
  },

  async stop(ctx) {
    requireSession(ctx);
    const [taskId, reason] = ctx.args as [string, string | undefined];
    return stopTask(ctx, taskId, reason);
  },

  async stopByUser(ctx) {
    requireSession(ctx);
    const taskId = ctx.args[0] as string;
    return stopTask(ctx, taskId, undefined);
  },
};

/** Stop a task through the engine's `bg/stop` and report the settled record;
 *  unknown task ids (engine RPC errors) resolve to `undefined` (v2 parity). */
async function stopTask(
  ctx: RustCallContext,
  taskId: string,
  reason: string | undefined,
): Promise<AgentTaskInfo | undefined> {
  let stopped = false;
  try {
    const result = await ctx.rust.bgStop(taskId, reason);
    stopped = result?.ok === true;
  } catch {
    stopped = false;
  }
  if (!stopped) return undefined;
  return findTask(ctx, taskId);
}

// ── registration (loaded via services/registry.ts) ─────────────────────────

registerService('agentPlanService', agentPlanService);
registerService('agentProfileService', agentProfileService);
registerService('agentShellCommandService', agentShellCommandService);
registerService('agentTaskService', agentTaskService);
