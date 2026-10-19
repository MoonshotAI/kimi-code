/**
 * `fileService` — process-global upload store. Mirrors
 * `agent-core-v2/app/file/fileService.ts`.
 *
 * The wire cannot carry the engine's streams (every value JSON round-trips),
 * so bytes cross base64-encoded: `save`'s `Readable` source becomes a base64
 * string as the first argument, and `get`'s result stream is buffered
 * server-side and returned as `{ meta, data }` with `data` base64-encoded.
 * The dispatcher performs the stream ⇄ base64 adaptation; the facade encodes
 * and decodes the caller's `Uint8Array`s.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const fileMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  created_at: z.string(),
  expires_at: z.string().optional(),
});

export const fileSaveOptionsSchema = z.object({
  name: z.string().optional(),
  mimeType: z.string().optional(),
  expiresInSec: z.number().optional(),
});

/** Wire result of `get` — the engine's `GetResult.stream` buffered to base64. */
export const fileGetResultSchema = z.object({
  meta: fileMetaSchema,
  data: z.string(),
});

export const filesContract = {
  save: {
    input: z.tuple([z.string(), z.string().min(1), fileSaveOptionsSchema]),
    output: fileMetaSchema,
  },
  get: { input: z.tuple([z.string().min(1)]), output: fileGetResultSchema },
  delete: { input: z.tuple([z.string().min(1)]), output: noResult },
} satisfies ServiceContract;
