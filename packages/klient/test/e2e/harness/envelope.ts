import { type Envelope } from '@moonshot-ai/kap-server/protocol/envelope';
import { ErrorCode } from '@moonshot-ai/kap-server/protocol/error-codes';

export class EnvelopeError<T = unknown> extends Error {
  readonly code: number;
  readonly reason: string;
  readonly requestId: string;
  readonly data: T | null;

  constructor(envelope: Envelope<T>) {
    const reason =
      Object.entries(ErrorCode)
        .find(([, value]) => value === envelope.code)?.[0]
        ?.toLowerCase()
        .replaceAll('_', '.') ?? 'unknown';
    super(`server returned code=${envelope.code} (${reason}): ${envelope.msg}`);
    this.name = 'EnvelopeError';
    this.code = envelope.code;
    this.reason = reason;
    this.requestId = envelope.request_id;
    this.data = envelope.data;
  }
}

export function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.code !== 0) throw new EnvelopeError(envelope);
  if (envelope.data === null) {
    throw new EnvelopeError({ ...envelope, code: 50001, msg: 'success envelope had null data' });
  }
  return envelope.data;
}
