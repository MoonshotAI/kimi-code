/**
 * `sessionFs` domain (L2) — wire-shaped filesystem operations.
 *
 * Defines the `ISessionFsService` that backs the fs REST surface: content search,
 * content grep, and git status/diff, together with the zod DTO schemas the
 * transports validate against. It orchestrates the os `IHostFileSystem`
 * (file IO, resolved against the workspace root) plus `ISessionProcessRunner`
 * (for `rg` / `git` / `gh`). Git status/diff DTOs live in the `git` domain.
 * Session-scoped — the scope itself is the session, so no `sessionId` is
 * threaded through.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';
import {
  fsGitStatusSchema,
  type FsDiffRequest,
  type FsDiffResponse,
  type FsGitStatusRequest,
  type FsGitStatusResponse,
} from '#/app/git/git';

export {
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
} from '#/app/git/git';
export type { FsDiffRequest, FsDiffResponse, FsGitStatusRequest, FsGitStatusResponse };

export const fsKindSchema = z.enum(['file', 'directory', 'symlink']);
export type FsKind = z.infer<typeof fsKindSchema>;

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

export const fsMkdirRequestSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
});
export type FsMkdirRequest = z.infer<typeof fsMkdirRequestSchema>;

export const fsMkdirResponseSchema = fsEntrySchema;
export type FsMkdirResponse = z.infer<typeof fsMkdirResponseSchema>;

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

export interface FsPathResolved {
  readonly absolute: string;
  readonly relative: string;
  readonly isDirectory: boolean;
}

export interface FsDownloadResolved {
  readonly absolute: string;
  readonly relative: string;
  readonly size: number;
  readonly etag: string;
  readonly mime: string;
  readonly modifiedAt: Date;
}

export interface ISessionFsService {
  readonly _serviceBrand: undefined;

  list(req: FsListRequest): Promise<FsListResponse>;
  read(req: FsReadRequest): Promise<FsReadResponse>;
  listMany(req: FsListManyRequest): Promise<FsListManyResponse>;
  stat(req: FsStatRequest): Promise<FsStatResponse>;
  statMany(req: FsStatManyRequest): Promise<FsStatManyResponse>;
  mkdir(req: FsMkdirRequest): Promise<FsMkdirResponse>;
  search(req: FsSearchRequest): Promise<FsSearchResponse>;
  grep(req: FsGrepRequest): Promise<FsGrepResponse>;
  gitStatus(req: FsGitStatusRequest): Promise<FsGitStatusResponse>;
  diff(req: FsDiffRequest): Promise<FsDiffResponse>;
  resolvePath(relPath: string): Promise<FsPathResolved>;
  resolveDownload(relPath: string): Promise<FsDownloadResolved>;
}

export const ISessionFsService: ServiceIdentifier<ISessionFsService> =
  createDecorator<ISessionFsService>('sessionFsService');
