import type { AnyFrame, WsClient } from './ws.js';

export interface ReverseRpcOptions<Req, Res> {
  requestEventType: string;
  idField: keyof Req & string;
  buildPath: (sessionId: string, id: string) => string;
  handler: (req: Req) => Promise<Res> | Res;
  postResolve: (sessionId: string, id: string, body: Res) => Promise<unknown>;
  logger: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: unknown) => void;
}

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
