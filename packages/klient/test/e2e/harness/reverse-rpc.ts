/**
 * Reverse-RPC handler installer — uniform pattern shared by approval and
 * question. The two flows are structurally identical:
 *
 *   1. WS broadcasts `event.{kind}.requested` with the request payload at
 *      the top level of `envelope.payload`.
 *   2. Test installs `onXxxRequested(handler)`.
 *   3. On each request frame, we call `handler(request)` → POST the
 *      decision/answer to `/sessions/{sid}/{kind}s/{id}`.
 *
 * Errors from the user handler (or the REST POST) are swallowed into a
 * logger.warn — failing reverse-RPC silently means the server will time out
 * the approval/question after 60s, which the scenario will observe as a
 * timeout in `waitForFrame`. Surfacing those errors here would break the
 * "framework auto-responds" contract.
 */
import type { AnyFrame, WsClient } from './ws.js';

export interface ReverseRpcOptions<Req, Res> {
  requestEventType: string;
  idField: keyof Req & string;
  /** REST path under the server API prefix. */
  buildPath: (sessionId: string, id: string) => string;
  handler: (req: Req) => Promise<Res> | Res;
  /** POST helper bound to the right path. */
  postResolve: (sessionId: string, id: string, body: Res) => Promise<unknown>;
  logger: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
}

/**
 * Subscribe to `requestEventType` frames on `ws` and POST the user-supplied
 * response. Returns an unsubscribe handle.
 */
export function installReverseRpcHandler<Req, Res>(
  ws: WsClient,
  opts: ReverseRpcOptions<Req, Res>,
): () => void {
  const unsubscribe = ws.onFrame((frame: AnyFrame) => {
    if (frame.type !== opts.requestEventType) return;
    const payload = frame.payload as Req | undefined;
    if (!payload) return;
    const sessionId = (payload as { session_id?: string }).session_id;
    const id = (payload as Record<string, unknown>)[opts.idField] as string | undefined;
    if (!sessionId || !id) {
      opts.logger('warn', `reverse-rpc: ${opts.requestEventType} missing session_id/${opts.idField}`, {
        payload,
      });
      return;
    }
    // Fire-and-forget: the WS handler is sync; we kick off the resolve and
    // log async failures.
    Promise.resolve()
      .then(async () => {
        const response = await opts.handler(payload);
        await opts.postResolve(sessionId, id, response);
      })
      .catch((err) => {
        opts.logger('warn', `reverse-rpc: ${opts.requestEventType} resolve failed`, {
          err: String(err),
          sessionId,
          id,
        });
      });
  });
  return unsubscribe;
}
