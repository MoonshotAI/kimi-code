/**
 *   POST /v1/sessions/{sid}/fs:list
 *     Body: FsListRequest
 *     Response data: FsListResponse  { items, children_by_path?, truncated }
 *     Errors: 40401, 40409, 41304, 41303
 *
 *   POST /v1/sessions/{sid}/fs:read
 *     Body: FsReadRequest
 *     Response data: FsReadResponse
 *     Errors: 40401, 40409, 40906, 40907, 41302, 41304
 *   POST /v1/sessions/{sid}/fs:list_many
 *     Body: FsListManyRequest  (paths[] up to 100)
 *     Response data: FsListManyResponse  { results, truncated_paths?,
 *                                          partial_errors? }
 *
 *   POST /v1/sessions/{sid}/fs:stat
 *     Body: FsStatRequest
 *     Response data: FsEntry
 *     Errors: 40401, 40409, 41304
 *
 *   POST /v1/sessions/{sid}/fs:stat_many
 *     Body: FsStatManyRequest  (paths[] up to 1000)
 *     Response data: FsStatManyResponse  { entries: { [path]: FsEntry | null } }
 *     Per-path failures land as `null` (REST.md §3.9 line 524); only
 *     path-safety (41304) fails the whole call.
 *   POST /v1/sessions/{sid}/fs:search
 *     Body: FsSearchRequest   { query, limit?, include_globs?, exclude_globs?,
 *                               follow_gitignore? }
 *     Response data: FsSearchResponse  { items, truncated }
 *     Errors: 40401, 41303, 41304
 *
 *   POST /v1/sessions/{sid}/fs:grep
 *     Body: FsGrepRequest
 *     Response data: FsGrepResponse  { files, files_scanned, truncated,
 *                                      elapsed_ms }
 *     Errors: 40401, 41303, 41304, 41305 (>30s grep timeout)
 *   POST /v1/sessions/{sid}/fs:git_status
 *     Body: FsGitStatusRequest  { paths? }
 *     Response data: FsGitStatusResponse  { branch, ahead, behind, entries }
 *     Errors: 40401, 40908 (not a git repo), 41304
 *
 *   GET /v1/sessions/{sid}/fs/{path}:download
 *     Response: binary stream or envelope (40401 / 40409 / 41304)
 */

import { z } from 'zod';

import {
  fsEntrySchema,
  fsGitStatusSchema,
  fsGrepFileHitSchema,
  fsSearchHitSchema,
} from '../fs';

export const fsListSortSchema = z.enum([
  'type_first',
  'name_asc',
  'name_desc',
  'mtime_desc',
  'size_desc',
]);
export type FsListSort = z.infer<typeof fsListSortSchema>;

export const fsListRequestSchema = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(1).max(10).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
  show_hidden: z.boolean().default(false),
  follow_gitignore: z.boolean().default(true),
  exclude_globs: z.array(z.string()).optional(),
  sort: fsListSortSchema.default('type_first'),
  include_git_status: z.boolean().default(false),
});
export type FsListRequest = z.infer<typeof fsListRequestSchema>;

export const fsListResponseSchema = z.object({
  items: z.array(fsEntrySchema),
  children_by_path: z.record(z.string(), z.array(fsEntrySchema)).optional(),
  truncated: z.boolean(),
});
export type FsListResponse = z.infer<typeof fsListResponseSchema>;

export const fsReadEncodingRequestSchema = z.enum(['auto', 'utf-8', 'base64']);
export const fsReadEncodingResponseSchema = z.enum(['utf-8', 'base64']);
export type FsReadEncoding = z.infer<typeof fsReadEncodingResponseSchema>;

export const fsReadRequestSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(10_485_760).default(1_048_576),
  encoding: fsReadEncodingRequestSchema.default('auto'),
});
export type FsReadRequest = z.infer<typeof fsReadRequestSchema>;

export const fsReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: fsReadEncodingResponseSchema,
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  etag: z.string(),
  mime: z.string(),
  language_id: z.string().optional(),
  line_count: z.number().int().nonnegative().optional(),
  is_binary: z.boolean(),
});
export type FsReadResponse = z.infer<typeof fsReadResponseSchema>;

export const fsListManyRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(100),
  depth: z.number().int().min(1).max(10).default(1),
  limit: z.number().int().min(1).max(1000).default(200),
  show_hidden: z.boolean().default(false),
  follow_gitignore: z.boolean().default(true),
  exclude_globs: z.array(z.string()).optional(),
  sort: fsListSortSchema.default('type_first'),
  include_git_status: z.boolean().default(false),
});
export type FsListManyRequest = z.infer<typeof fsListManyRequestSchema>;

export const fsListManyPartialErrorSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type FsListManyPartialError = z.infer<typeof fsListManyPartialErrorSchema>;

export const fsListManyResponseSchema = z.object({
  results: z.record(z.string(), z.array(fsEntrySchema)),
  truncated_paths: z.array(z.string()).optional(),
  partial_errors: z.record(z.string(), fsListManyPartialErrorSchema).optional(),
});
export type FsListManyResponse = z.infer<typeof fsListManyResponseSchema>;

export const fsStatRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsStatRequest = z.infer<typeof fsStatRequestSchema>;

export const fsStatResponseSchema = fsEntrySchema;
export type FsStatResponse = z.infer<typeof fsStatResponseSchema>;

export const fsStatManyRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(1000),
});
export type FsStatManyRequest = z.infer<typeof fsStatManyRequestSchema>;

export const fsStatManyResponseSchema = z.object({
  entries: z.record(z.string(), fsEntrySchema.nullable()),
});
export type FsStatManyResponse = z.infer<typeof fsStatManyResponseSchema>;

export const fsSearchRequestSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  follow_gitignore: z.boolean().default(true),
});
export type FsSearchRequest = z.infer<typeof fsSearchRequestSchema>;

export const fsSearchResponseSchema = z.object({
  items: z.array(fsSearchHitSchema),
  truncated: z.boolean(),
});
export type FsSearchResponse = z.infer<typeof fsSearchResponseSchema>;

export const fsGrepRequestSchema = z.object({
  pattern: z.string().min(1),
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(true),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  follow_gitignore: z.boolean().default(true),
  max_files: z.number().int().min(1).max(10_000).default(200),
  max_matches_per_file: z.number().int().min(1).max(10_000).default(50),
  max_total_matches: z.number().int().min(1).max(100_000).default(5000),
  context_lines: z.number().int().min(0).max(10).default(2),
});
export type FsGrepRequest = z.infer<typeof fsGrepRequestSchema>;

export const fsGrepResponseSchema = z.object({
  files: z.array(fsGrepFileHitSchema),
  files_scanned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  elapsed_ms: z.number().int().nonnegative(),
});
export type FsGrepResponse = z.infer<typeof fsGrepResponseSchema>;

export const fsGitStatusRequestSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

export const fsGitStatusResponseSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.record(z.string(), fsGitStatusSchema),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

export const fsDownloadParamsSchema = z.object({
  path: z.string().min(1),
  range: z.string().optional(),
  if_none_match: z.string().optional(),
});
export type FsDownloadParams = z.infer<typeof fsDownloadParamsSchema>;
