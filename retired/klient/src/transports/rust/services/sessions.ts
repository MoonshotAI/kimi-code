/**
 * `sessionLifecycleService` + `sessionMetadata` — G2 session lifecycle and
 * typed session metadata over the Rust engine.
 *
 * The engine's session surface is deliberately thin: `session/create` has no
 * workspace or additional-dirs fields (the work dir is recorded from
 * `homedir`), there is no archive/closed concept, no title RPC, and
 * `session/list` returns only id/timestamps/title/work_dir — metadata written
 * via `session/update_metadata` is never readable back. So this module keeps
 * a host-side shadow registry for the fields the engine cannot return
 * (`archived`, `custom`, `isCustomTitle`, `lastPrompt`, `agents`, …): the
 * engine record stays the source for id/timestamps/cwd, the shadow supplies
 * the rest, and every metadata write is also pushed into the engine
 * (`session/update_metadata`) as best-effort persistence. Both services
 * share one registration name per domain — `scope.sessionId` decides the
 * target session.
 */

import type { SessionCreateOptions } from '@moonshot-ai/kimi-agent/rust-loop';

import { RPCError } from '../../../core/errors.js';
import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

/** Session-scope handle `kind` (mirrors agent-core-v2 `LifecycleScope.Session`). */
const SESSION_SCOPE_KIND = 1;
/** Mirrors the v2 dispatcher / memory transport's unknown-session code. */
const SESSION_NOT_FOUND = 40404;
/** Mirrors the v2 dispatcher's unknown-method / bad-args code. */
const REQUEST_INVALID = 40001;

/** Wire shape of the contract's `createSessionOptions` (facade passes only
 *  `{ workDir, additionalDirs }` today; `sessionId`/`mcpServers` are allowed
 *  by the contract and pass through). */
interface CreateSessionInput {
  sessionId?: string;
  workDir: string;
  additionalDirs?: string[];
  mcpServers?: Record<string, unknown>;
}

/** Subset of `agentMetaSchema` — loose enough for the shadow, exact enough to
 *  satisfy `sessionMetaSchema.agents` (inputs are contract-validated before
 *  they reach the service). */
interface AgentMetaLike {
  homedir?: string;
  type?: string;
  parentAgentId?: string | null;
  forkedFrom?: string;
  labels?: Record<string, string>;
  swarmItem?: string;
}

/** Fields `sessionMetaSchema` carries that the engine cannot read back. */
interface SessionShadow {
  version?: number;
  title?: string;
  isCustomTitle?: boolean;
  lastPrompt?: string;
  updatedAt?: number;
  archived?: boolean;
  cwd?: string;
  forkedFrom?: string;
  agents?: Record<string, AgentMetaLike>;
  custom?: Record<string, unknown>;
  additionalDirs?: string[];
}

/** Wire shape of the contract's `sessionMetaSchema`. */
interface SessionMeta {
  id: string;
  version?: number;
  title?: string;
  isCustomTitle?: boolean;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  cwd?: string;
  forkedFrom?: string;
  agents?: Record<string, AgentMetaLike>;
  custom?: Record<string, unknown>;
}

/** Wire shape of the contract's `sessionMetaPatchSchema`. */
type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

/** Host-side shadow store. Module-level because the engine store itself is
 *  process-global — every rust klient in the process observes the same
 *  sessions, so they share one shadow. */
const shadows = new Map<string, SessionShadow>();

function shadowOf(sessionId: string): SessionShadow {
  let shadow = shadows.get(sessionId);
  if (shadow === undefined) {
    shadow = {};
    shadows.set(sessionId, shadow);
  }
  return shadow;
}

function parseTime(value: string | undefined): number {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Resolve the target session id: `scope.sessionId` first (the facade's
 *  convention for session-scoped calls), then the positional argument
 *  (lifecycle methods receive it as `args[0]`). */
function sessionIdOf(ctx: RustCallContext): string {
  const fromScope = ctx.scope.sessionId;
  if (fromScope !== undefined) return fromScope;
  const arg = ctx.args[0];
  if (typeof arg === 'string' && arg.length > 0) return arg;
  if (typeof arg === 'object' && arg !== null) {
    const id = (arg as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  throw new RPCError(REQUEST_INVALID, 'no session id in scope or args');
}

/** Push a metadata patch into the engine's custom metadata. The engine only
 *  accepts writes for live agents and never exposes the value back, so a
 *  failed write on an absent agent is tolerated (the shadow remains the read
 *  model); a failure while the agent is live is a real error and rethrows. */
async function persistMetadata(
  ctx: RustCallContext,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.rust.sessionUpdateMetadata(sessionId, patch);
  } catch (error) {
    const status = await ctx.rust.sessionGetStatus(sessionId).catch(() => null);
    if (status !== null) throw error;
  }
}

/** Map the contract's `Record<name, config>` MCP servers onto the engine's
 *  `McpServerInput[]` (the klient `headers`/`executor` extras have no engine
 *  slot and are dropped). */
function toMcpServerInputs(servers: unknown): SessionCreateOptions['mcpServers'] {
  if (servers === undefined) return undefined;
  return Object.entries(servers as Record<string, Record<string, unknown>>).map(
    ([name, cfg]) => ({
      name,
      transport: cfg['transport'] as 'stdio' | 'sse' | 'http' | undefined,
      enabled: cfg['enabled'] as boolean | undefined,
      command: cfg['command'] as string | undefined,
      args: cfg['args'] as string[] | undefined,
      env: cfg['env'] as Record<string, string> | undefined,
      cwd: cfg['cwd'] as string | undefined,
      url: cfg['url'] as string | undefined,
      enabledTools: cfg['enabledTools'] as string[] | undefined,
      disabledTools: cfg['disabledTools'] as string[] | undefined,
      startupTimeoutMs: cfg['startupTimeoutMs'] as number | undefined,
      toolTimeoutMs: cfg['toolTimeoutMs'] as number | undefined,
    }),
  );
}

export const sessionLifecycleService: RustServiceRegistry = {
  /** Engine-backed: `sessionCreate`. `workDir` rides the `homedir` field —
   *  the engine records it as the session's `work_dir` at create time. */
  async create(ctx) {
    const input = (ctx.args[0] ?? {}) as CreateSessionInput;
    const created = await ctx.rust.sessionCreate({
      sessionId: input.sessionId,
      homedir: input.workDir,
      mcpServers: toMcpServerInputs(input.mcpServers),
    });
    if (created === null) {
      throw new Error(`rust engine unavailable: session/create failed for ${input.workDir}`);
    }
    const sessionId = created.session_id;
    if (input.additionalDirs !== undefined && input.additionalDirs.length > 0) {
      shadowOf(sessionId).additionalDirs = [...input.additionalDirs];
    }
    return { id: sessionId, kind: SESSION_SCOPE_KIND };
  },

  /** Engine-backed: `sessionDelete` (removes the persisted record and the
   *  live agent). Also drops the host shadow. */
  async delete(ctx) {
    const sessionId = sessionIdOf(ctx);
    await ctx.rust.sessionDelete(sessionId);
    shadows.delete(sessionId);
  },

  /** The engine has no archive concept — archive marks the session's
   *  metadata `archived: true` (shadow + best-effort engine write). */
  async archive(ctx) {
    const sessionId = sessionIdOf(ctx);
    shadowOf(sessionId).archived = true;
    await persistMetadata(ctx, sessionId, { archived: true });
  },

  /** Persist the session's state. The engine's teardown half (`session/
   *  destroy`) is not wrapped by rust-loop, and a full delete would make
   *  `restore` impossible — so close is a durable save, matching the
   *  node-sdk's rust `closeSession` (save only). */
  async close(ctx) {
    const sessionId = sessionIdOf(ctx);
    await ctx.rust.sessionSave(sessionId);
  },

  /** Engine-backed: `sessionLoad`. Returns the session handle when the
   *  persisted record existed, `null` otherwise (the contract's `maybe`). */
  async restore(ctx) {
    const sessionId = sessionIdOf(ctx);
    const result = await ctx.rust.sessionLoad(sessionId);
    if (result?.found !== true) return null;
    return { id: sessionId, kind: SESSION_SCOPE_KIND };
  },
};

export const sessionMetadata: RustServiceRegistry = {
  /** Engine record (`sessionList` → id/timestamps/cwd/title) merged with the
   *  host shadow (archived/custom/isCustomTitle/…); `sessionGetStatus`
   *  confirms the session exists when no record surfaces. */
  async read(ctx) {
    const sessionId = sessionIdOf(ctx);
    const [listResult, status] = await Promise.all([
      ctx.rust.sessionList(1000, 0),
      // `session/get_status` rejects with "no agent for session" when the
      // session is gone — that is the not-live signal, not a transport error
      // (real RPC failures still surface through the `sessionList` call).
      ctx.rust.sessionGetStatus(sessionId).catch(() => null),
    ]);
    const record = listResult?.sessions?.find((s) => s.id === sessionId);
    if (record === undefined && status === null) {
      throw new RPCError(SESSION_NOT_FOUND, `session not found: ${sessionId}`);
    }
    const shadow = shadows.get(sessionId);
    const title = shadow?.title ?? (record?.title ? record.title : undefined);
    const meta: SessionMeta = {
      id: sessionId,
      createdAt: parseTime(record?.created_at),
      updatedAt: shadow?.updatedAt ?? parseTime(record?.updated_at),
      archived: shadow?.archived ?? false,
      cwd: (shadow?.cwd ?? record?.work_dir) || undefined,
    };
    if (shadow?.version !== undefined) meta.version = shadow.version;
    if (title !== undefined) meta.title = title;
    if (shadow?.isCustomTitle !== undefined) meta.isCustomTitle = shadow.isCustomTitle;
    if (shadow?.lastPrompt !== undefined) meta.lastPrompt = shadow.lastPrompt;
    if (shadow?.forkedFrom !== undefined) meta.forkedFrom = shadow.forkedFrom;
    if (shadow?.agents !== undefined) meta.agents = shadow.agents;
    if (shadow?.custom !== undefined) meta.custom = shadow.custom;
    return meta;
  },

  /** Shadow + engine write; a custom title marks `isCustomTitle` (v2 parity). */
  async setTitle(ctx) {
    const sessionId = sessionIdOf(ctx);
    const title = ctx.args[0] as string;
    const shadow = shadowOf(sessionId);
    shadow.title = title;
    shadow.isCustomTitle = true;
    await persistMetadata(ctx, sessionId, { title, isCustomTitle: true });
  },

  /** Shallow-merge the patch into the shadow and push it to the engine. */
  async update(ctx) {
    const sessionId = sessionIdOf(ctx);
    const patch = (ctx.args[0] ?? {}) as SessionMetaPatch;
    Object.assign(shadowOf(sessionId), patch);
    await persistMetadata(ctx, sessionId, patch as Record<string, unknown>);
  },

  /** Shadow + engine write of the `archived` flag. */
  async setArchived(ctx) {
    const sessionId = sessionIdOf(ctx);
    const archived = ctx.args[0] as boolean;
    shadowOf(sessionId).archived = archived;
    await persistMetadata(ctx, sessionId, { archived });
  },
};

registerService('sessionLifecycleService', sessionLifecycleService);
registerService('sessionMetadata', sessionMetadata);
