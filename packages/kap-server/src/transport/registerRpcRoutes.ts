/**
 * `/api/v2` route registration — mounts the channel dispatcher on Fastify.
 *
 * Three routes mirror the scope tree; all share one handler. `:service` is a
 * decorator id (channel name) resolved by the registry; `:method` is invoked by
 * reflection. Reads use `GET`, writes use `POST`.
 *
 *   GET|POST /api/v2/:service/:method
 *   GET|POST /api/v2/session/:session_id/:service/:method
 *   GET|POST /api/v2/session/:session_id/agent/:agent_id/:service/:method
 *
 * Body (POST) or `?arg=<json>` (GET) is the method's single argument. Responses
 * are always the project envelope (HTTP 200; business outcome in `code`). Body
 * size, connection timeout, and graceful close are Fastify's.
 *
 * `registerServiceDispatcherRoutes` is the shared, path-agnostic core: the
 * dev-only `/api/v1/debug` surface (`registerDebugRoutes.ts`) mounts the same
 * dispatcher with a different base path and a whitelist-free channel lookup.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';

import { requestLog } from '../lib/requestLog';
import { okEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { ScopeKind } from './channel';
import { type ChannelDescriptor, describeChannels, resolveChannel } from './channelRegistry';
import { type ChannelLookup, dispatch } from './dispatcher';
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

export interface RouteHost {
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

export interface ServiceDispatcherRouteOptions {
  /** Per-call deadline in ms. Default 30s. */
  readonly callTimeoutMs?: number;
  /** Channel name → identifier resolution. Default: the `/api/v2` whitelist registry. */
  readonly lookup?: ChannelLookup;
  /** Descriptor source for `GET {basePath}/channels`. Default: the whitelist set. */
  readonly describe?: () => readonly ChannelDescriptor[];
}

/**
 * Mount the reflection dispatcher under `basePath` (e.g. `/api/v2`, or
 * `/debug` inside the prefixed `/api/v1` plugin): the three scope routes plus
 * `GET {basePath}/channels` for introspection. `channels` is a single segment,
 * so it cannot collide with `:service/:method`.
 */
export function registerServiceDispatcherRoutes(
  app: RouteHost,
  core: Scope,
  basePath: string,
  opts: ServiceDispatcherRouteOptions = {},
): void {
  const lookup = opts.lookup ?? resolveChannel;
  const scopeRoutes: { path: string; scopeKind: ScopeKind }[] = [
    { path: `${basePath}/:service/:method`, scopeKind: 'core' },
    { path: `${basePath}/session/:session_id/:service/:method`, scopeKind: 'session' },
    {
      path: `${basePath}/session/:session_id/agent/:agent_id/:service/:method`,
      scopeKind: 'agent',
    },
  ];
  for (const { path, scopeKind } of scopeRoutes) {
    const handler = makeHandler(core, scopeKind, opts, lookup);
    app.get(path, handler);
    app.post(path, handler);
  }

  // Introspection: the dynamic service browser (kimi-inspect) reads this once
  // per connection.
  const describe = opts.describe ?? describeChannels;
  app.get(`${basePath}/channels`, async (req, reply) =>
    reply.send(okEnvelope(describe(), req.id)),
  );
}

export function registerRpcRoutes(
  app: RouteHost,
  core: Scope,
  opts: RegisterRpcRoutesOptions = {},
): void {
  registerServiceDispatcherRoutes(app, core, '/api/v2', opts);
}

function makeHandler(
  core: Scope,
  scopeKind: ScopeKind,
  opts: ServiceDispatcherRouteOptions,
  lookup: ChannelLookup,
): (req: RpcRequest, reply: RpcReply) => Promise<unknown> {
  return async (req, reply) => {
    const requestId = req.id;

    // Auth is enforced upstream by the global bearer hook (see
    // `middleware/auth.ts`); the handler runs only after a valid credential
    // has been verified.

    const { service, method } = req.params as { service: string; method: string };

    // Parse argument.
    let arg: unknown;
    try {
      arg = req.method.toUpperCase() === 'GET' ? parseArgFromQuery(req.query) : req.body;
    } catch {
      return reply.send(
        validationEnvelope([{ path: 'arg', message: 'invalid JSON in ?arg=' }], requestId),
      );
    }

    // Dispatch + timeout + envelope.
    try {
      const result = await withTimeout(
        dispatch(
          core,
          scopeKind,
          req.params as Record<string, string>,
          service,
          method,
          arg,
          lookup,
        ),
        opts.callTimeoutMs ?? 30_000,
      );
      return reply.send(okEnvelope(result, requestId));
    } catch (error) {
      const envelope = mapError(error, requestId);
      // 50001 (including the 30s call timeout) is a server-side failure — log
      // at error; mapped business codes (4xxxx) are expected client outcomes.
      const log = requestLog(req);
      if (envelope.code === ErrorCode.INTERNAL_ERROR) {
        log?.error({ err: error, service, method }, 'rpc dispatch failed');
      } else {
        log?.warn({ err: error, service, method }, 'rpc dispatch failed');
      }
      return reply.send(envelope);
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
