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

export const fsChangeKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FsChangeKind = z.infer<typeof fsChangeKindSchema>;

export const fsChangeActionSchema = z.enum(['created', 'modified', 'deleted']);
export type FsChangeAction = z.infer<typeof fsChangeActionSchema>;

export const fsChangeEntrySchema = z.object({
  path: z.string(),
  change: fsChangeActionSchema,
  kind: fsChangeKindSchema,
  size_delta: z.number().int().optional(),
  etag: z.string().optional(),
});
export type FsChangeEntry = z.infer<typeof fsChangeEntrySchema>;

/**
 * Payload of the volatile `event.fs.changed` frame on `/api/v1/ws`:
 *
 *   { type: 'event.fs.changed', seq, session_id, timestamp, payload: FsChangeEvent }
 *
 * The frames never enter the journal — the stream is volatile and there is no
 * catch-up cursor. `seq` is **per-connection monotonic**: each WebSocket
 * connection numbers only the frames actually delivered to it (matched change
 * frames and `truncated` frames alike), starting at 1 with no gaps; a frame
 * dispatched only to other connections does not advance yours.
 *
 * `truncated: true` (with `count`; `changes` empty) means the coalescing
 * window overflowed server-side and that window's entries were dropped
 * wholesale — the incremental stream after the previously received `seq` is
 * no longer trustworthy. On `truncated`, on a `seq` gap, or on an epoch
 * change, the client MUST rebuild its baseline with a full REST listing
 * (`POST /sessions/{sid}/fs:list`) and resume applying increments on top;
 * partial continuation after a truncation is not defined. Truncated frames
 * are broadcast to every connection watching the session, regardless of each
 * connection's path set.
 */
export const fsChangeEventSchema = z.object({
  changes: z.array(fsChangeEntrySchema),
  coalesced_window_ms: z.number().int().positive(),
  truncated: z.boolean().optional(),
  count: z.number().int().nonnegative().optional(),
});
export type FsChangeEvent = z.infer<typeof fsChangeEventSchema>;
