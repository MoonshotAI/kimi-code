interface RawErrorReply {
  code(status: number): { send(payload: unknown): unknown };
  send(payload: unknown): unknown;
}

export function sendRawError(
  reply: RawErrorReply,
  envelope: { code: number },
): unknown {
  const status = Math.floor(envelope.code / 100);
  return reply.code(status >= 400 && status <= 599 ? status : 500).send(envelope);
}
