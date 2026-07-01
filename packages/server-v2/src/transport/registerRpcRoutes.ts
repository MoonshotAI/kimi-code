/**
 * `/api/v2` route registration — mounts the channel dispatcher on Fastify.
 *
 * Three routes mirror the scope tree; all share one handler. `:sa` is the
 * `resource:action` segment. Reads use `GET`, writes use `POST`.
 *
 *   GET|POST /api/v2/:sa
 *   GET|POST /api/v2/session/:session_id/:sa
 *   GET|POST /api/v2/session/:session_id/agent/:agent_id/:sa
 *
 * Body (POST) or `?arg=<json>` (GET) is the method's single argument.
 * Responses are always the project envelope (HTTP 200; business outcome in
 * `code`). Body size, connection timeout, and graceful close are Fastify's.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { okEnvelope } from '@moonshot-ai/protocol';

import { actionMap } from './actionMap';
import type { ScopeKind } from './channel';
import { parseServiceAction } from './channel';
import { dispatch } from './dispatcher';
import { mapError, validationEnvelope, withTimeout } from './errors';

interface RpcRequest {
  readonly id: string;
  readonly method: string;
  readonly body: unknown;
  readonly query: unknown;
  readonly params: unknown;
  readonly headers: Record<string, unknown>;
}

interface RpcReply {
  status(code: number): { send(payload: unknown): unknown };
  send(payload: unknown): unknown;
}

interface RouteHost {
  get(path: string, handler: (req: RpcRequest, reply: RpcReply) => Promise<unknown>): unknown;
  post(path: string, handler: (req: RpcRequest, reply: RpcReply) => Promise<unknown>): unknown;
}

export interface RegisterRpcRoutesOptions {
  /**
   * @deprecated Auth is enforced by the global bearer hook (`middleware/auth`)
   * before the handler runs — the persistent token (and, when configured, the
   * `rpcToken`) gates every `/api/v2` route. Kept for call-site compatibility;
   * the route handler itself no longer performs a separate token check.
   */
  readonly token?: string;
  /** Per-call deadline in ms. Default 30s. */
  readonly callTimeoutMs?: number;
}

const SCOPE_ROUTES: { path: string; scopeKind: ScopeKind }[] = [
  { path: '/api/v2/:sa', scopeKind: 'core' },
  { path: '/api/v2/session/:session_id/:sa', scopeKind: 'session' },
  { path: '/api/v2/session/:session_id/agent/:agent_id/:sa', scopeKind: 'agent' },
];

export function registerRpcRoutes(
  app: RouteHost,
  core: Scope,
  opts: RegisterRpcRoutesOptions = {},
): void {
  for (const { path, scopeKind } of SCOPE_ROUTES) {
    const handler = makeHandler(core, scopeKind, opts);
    app.get(path, handler);
    app.post(path, handler);
  }
}

function makeHandler(
  core: Scope,
  scopeKind: ScopeKind,
  opts: RegisterRpcRoutesOptions,
): (req: RpcRequest, reply: RpcReply) => Promise<unknown> {
  return async (req, reply) => {
    const requestId = req.id;

    // Auth is enforced upstream by the global bearer hook (see
    // `middleware/auth.ts`); the handler runs only after a valid credential
    // has been verified.

    // Parse `resource:action`.
    const { sa } = req.params as { sa: string };
    const parsed = parseServiceAction(sa);
    if (parsed === undefined) {
      return reply.send(
        validationEnvelope(
          [{ path: 'action', message: `expected <resource>:<action>, got '${sa}'` }],
          requestId,
        ),
      );
    }

    // Read vs write gate.
    const target = actionMap[scopeKind][`${parsed.resource}:${parsed.action}`];
    const isGet = req.method.toUpperCase() === 'GET';
    if (isGet && target !== undefined && target.readonly !== true) {
      return reply.send(
        validationEnvelope(
          [{ path: 'action', message: `'${sa}' is not a read action` }],
          requestId,
        ),
      );
    }

    // Parse argument.
    let arg: unknown;
    try {
      arg = isGet ? parseArgFromQuery(req.query) : req.body;
    } catch {
      return reply.send(
        validationEnvelope([{ path: 'arg', message: 'invalid JSON in ?arg=' }], requestId),
      );
    }

    // Dispatch + timeout + envelope.
    try {
      const result = await withTimeout(
        dispatch(core, scopeKind, req.params as Record<string, string>, parsed, arg),
        opts.callTimeoutMs ?? 30_000,
      );
      return reply.send(okEnvelope(result, requestId));
    } catch (error) {
      return reply.send(mapError(error, requestId));
    }
  };
}

function parseArgFromQuery(query: unknown): unknown {
  const q = query as Record<string, unknown> | undefined;
  const raw = q?.['arg'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  return JSON.parse(raw) as unknown;
}
