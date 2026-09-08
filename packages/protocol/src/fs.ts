import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const fsKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FsKind = z.infer<typeof fsKindSchema>;

export const fsGitStatusSchema = z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

export const fsEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  size: z.number().int().nonnegative().optional(),
  modified_at: isoDateTimeSchema,
  etag: z.string().optional(),
  mime: z.string().optional(),
  language_id: z.string().optional(),
  is_binary: z.boolean().optional(),
  is_symlink_to: z.string().optional(),
  git_status: fsGitStatusSchema.optional(),
  child_count: z.number().int().nonnegative().optional(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsSearchHitSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  score: z.number().min(0).max(1),
  match_positions: z.array(z.number().int().nonnegative()),
});
export type FsSearchHit = z.infer<typeof fsSearchHitSchema>;

export const fsSuggestItemSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: fsKindSchema,
  score: z.number().min(0).max(1),
  match_positions: z.array(z.number().int().nonnegative()),
});
export type FsSuggestItem = z.infer<typeof fsSuggestItemSchema>;

export const fsGrepMatchSchema = z.object({
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
});
export type FsGrepMatch = z.infer<typeof fsGrepMatchSchema>;

export const fsGrepFileHitSchema = z.object({
  path: z.string(),
  matches: z.array(fsGrepMatchSchema),
});
export type FsGrepFileHit = z.infer<typeof fsGrepFileHitSchema>;

export const fsGitStatusEntrySchema = z.object({
  path: z.string(),
  status: fsGitStatusSchema,
  rename_from: z.string().optional(),
});
export type FsGitStatusEntry = z.infer<typeof fsGitStatusEntrySchema>;
