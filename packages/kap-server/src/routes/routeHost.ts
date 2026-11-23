type RouteHandler<TReq> = (
  req: TReq,
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

export interface RouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: RouteHandler<{ id: string; params: unknown }>,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: RouteHandler<{ id: string; body: unknown; params: unknown }>,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: RouteHandler<{ id: string; body: unknown; params: unknown }>,
  ): unknown;
}
