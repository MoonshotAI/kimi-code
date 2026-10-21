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
