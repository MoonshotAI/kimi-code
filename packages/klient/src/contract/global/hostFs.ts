/**
 * `hostFolderBrowser` — host-side folder picker for choosing a workspace
 * folder. Mirrors `agent-core-v2/app/hostFolderBrowser/hostFolderBrowser.ts`;
 * wire shapes mirror `protocol/src/rest/fsBrowse.ts` (snake_case fields).
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const fsBrowseEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  is_dir: z.literal(true),
});

export const fsBrowseResponseSchema = z.object({
  path: z.string().min(1),
  parent: z.string().min(1).nullable(),
  entries: z.array(fsBrowseEntrySchema),
});

export const fsHomeResponseSchema = z.object({
  home: z.string().min(1),
  recent_roots: z.array(z.string().min(1)),
});

export const hostFsContract = {
  browse: { input: z.tuple([z.string().optional()]), output: fsBrowseResponseSchema },
  home: { input: z.tuple([]), output: fsHomeResponseSchema },
} satisfies ServiceContract;
