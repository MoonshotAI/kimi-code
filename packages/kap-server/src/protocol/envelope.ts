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

let stackTracesEnabled = false;

/** Enable stack traces in error envelopes (debug/loopback only). */
export function enableEnvelopeStackTraces(): void {
  stackTracesEnabled = true;
}

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

/**
 * Build an error envelope. Stack traces are only included when
 * `enableEnvelopeStackTraces()` has been called (loopback + debug mode);
 * otherwise the `stack` parameter is ignored to prevent information
 * disclosure on non-loopback binds.
 */
export function errEnvelope(
  code: number,
  msg: string,
  requestId: string,
  stack?: string,
): Envelope<null> {
  return { code, msg, data: null, request_id: requestId, stack: stackTracesEnabled ? stack : undefined };
}
