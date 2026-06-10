import { z } from 'zod';

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
  });

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
}

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

export function errEnvelope(code: number, msg: string, requestId: string): Envelope<null> {
  return { code, msg, data: null, request_id: requestId };
}
