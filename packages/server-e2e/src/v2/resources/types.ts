/**
 * Precise wire types for the high-value `/api/v2` actions.
 *
 * Only the actions the SDK wants strong typing for are listed here; everything
 * else falls back to `(arg?: unknown) => Promise<unknown>` via `ResourceShape`.
 * Shapes are derived from the server's own `server-v2/test/rpc.test.ts` wire
 * examples and are intentionally loose on unknown fields (`[k: string]: unknown`
 * or optional keys) so the server can evolve without breaking the client.
 *
 * Every override uses an optional arg to match the wire, where every action body
 * is optional.
 */

// ── Shared wire shapes ─────────────────────────────────────────────────────

/** Session metadata as returned by `sessions:get` / `session:read`. */
export interface SessionMeta {
  readonly id: string;
  readonly title?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly archived?: boolean;
  readonly [k: string]: unknown;
}

/** `session:status` result. The server may add new states; keep it open. */
export type SessionActivityStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | (string & {});

/** Workspace record as returned by `workspaces:*`. */
export interface WorkspaceInfo {
  readonly id: string;
  readonly root: string;
  readonly name?: string;
  readonly [k: string]: unknown;
}

/** Generic paginated list envelope used by list actions. */
export interface ListResult<T> {
  readonly items: readonly T[];
  readonly has_more?: boolean;
}

/** `prompts:submit` argument. `input` is the only required field. */
export interface PromptSubmitArg {
  readonly input: readonly PromptInputPart[];
  readonly [k: string]: unknown;
}

export type PromptInputPart = { readonly type: 'text'; readonly text: string } | {
  readonly type: string;
  readonly [k: string]: unknown;
};

/** `prompts:submit` result. */
export interface PromptSubmitResult {
  readonly turn_id: number;
  readonly [k: string]: unknown;
}

/** `shell:run` argument. */
export interface ShellRunArg {
  readonly command: string;
  readonly [k: string]: unknown;
}

/** `shell:run` result. */
export interface ShellRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly [k: string]: unknown;
}

// ── Precise override maps (keyed by action name) ───────────────────────────

export interface SessionsPrecise {
  list(arg?: { page_size?: number; [k: string]: unknown }): Promise<ListResult<SessionMeta>>;
  get(arg?: string): Promise<SessionMeta>;
  countActive(arg?: string): Promise<number>;
}

export interface WorkspacesPrecise {
  list(arg?: unknown): Promise<ListResult<WorkspaceInfo>>;
  get(arg?: string): Promise<WorkspaceInfo>;
  createOrTouch(arg?: string): Promise<WorkspaceInfo>;
  update(arg?: [string, { name?: string }]): Promise<WorkspaceInfo>;
  delete(arg?: string): Promise<null>;
}

/** The `session` resource at session scope (read/update/setTitle/…). */
export interface SessionResourcePrecise {
  read(arg?: unknown): Promise<SessionMeta>;
  update(arg?: unknown): Promise<SessionMeta>;
  setTitle(arg?: string): Promise<null>;
  setArchived(arg?: boolean): Promise<null>;
  status(arg?: unknown): Promise<SessionActivityStatus>;
  isIdle(arg?: unknown): Promise<boolean>;
  archive(arg?: unknown): Promise<null>;
}

export interface PromptsPrecise {
  submit(arg?: PromptSubmitArg): Promise<PromptSubmitResult>;
}

export interface ShellPrecise {
  run(arg?: ShellRunArg): Promise<ShellRunResult>;
  cancel(arg?: unknown): Promise<null>;
}

export interface ProfilePrecise {
  getModel(arg?: unknown): Promise<string>;
}
