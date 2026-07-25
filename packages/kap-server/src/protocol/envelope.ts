/**
 * The wire envelope `{ code, msg, data, request_id }` every REST response is
 * wrapped in, plus the envelope JSON-schema factory used for OpenAPI
 * generation. Owned by the server: it is a pure transport concern.
 */

import { z } from 'zod';

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
    stack: z.string().optional(),
  });

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
  stack?: string;
}

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

/**
 * Build an error envelope. When `stack` is provided it is surfaced verbatim on
 * the wire so operators can see where a thrown error originated; when omitted
 * (or `undefined`) the field is absent and the wire shape stays byte-identical
 * to the original `{ code, msg, data: null, request_id }` — `JSON.stringify`
 * drops `undefined` properties, so callers that have no stack are unaffected.
 */
export function errEnvelope(
  code: number,
  msg: string,
  requestId: string,
  stack?: string,
): Envelope<null> {
  return { code, msg, data: null, request_id: requestId, stack };
}
