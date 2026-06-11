/**
 *   GET /v1/fs:browse?path=<abs-path>
 *     Reply: FsBrowseResponse
 *
 *   GET /v1/fs:home
 *     Reply: FsHomeResponse
 *
 * Errors:
 *   - 40001 validation.failed       (path is not absolute)
 *   - 40409 fs.path_not_found       (ENOENT / ENOTDIR)
 *   - 40411 fs.permission_denied    (EACCES)
 */

import { z } from 'zod';

export const fsBrowseQuerySchema = z.object({
  path: z.string().min(1).optional(),
});
export type FsBrowseQuery = z.infer<typeof fsBrowseQuerySchema>;

export const fsBrowseEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  is_dir: z.literal(true),
  is_git_repo: z.boolean(),
  branch: z.string().optional(),
});
export type FsBrowseEntry = z.infer<typeof fsBrowseEntrySchema>;

export const fsBrowseResponseSchema = z.object({
  path: z.string().min(1),
  parent: z.string().min(1).nullable(),
  entries: z.array(fsBrowseEntrySchema),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

export const fsHomeResponseSchema = z.object({
  home: z.string().min(1),
  recent_roots: z.array(z.string().min(1)),
});
export type FsHomeResponse = z.infer<typeof fsHomeResponseSchema>;
