import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { GitWorkTree } from './workTree';

export type { GitWorkTree } from './workTree';

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

export const fsPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'merged', 'closed', 'draft']),
  url: z.string().url(),
});
export type FsPullRequest = z.infer<typeof fsPullRequestSchema>;

export const fsGitStatusRequestSchema = z.object({
  root: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  include_pull_request: z.boolean().optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

export const fsPullRequestRequestSchema = z.object({
  root: z.string().min(1).optional(),
});
export type FsPullRequestRequest = z.infer<typeof fsPullRequestRequestSchema>;

export interface GitStatusOptions {
  pathFilter?: ReadonlySet<string>;
  scopeToCwd?: boolean;
  includePullRequest?: boolean;
}

export const fsGitStatusResponseSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.record(z.string(), fsGitStatusSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  pullRequest: fsPullRequestSchema.nullable(),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

export const fsBatchErrorSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
});
export type FsBatchError = z.infer<typeof fsBatchErrorSchema>;

export const fsGitStatusBatchRequestSchema = z.object({
  roots: z.array(z.string().min(1)).min(1).max(32),
  include_pull_request: z.boolean().optional(),
});
export type FsGitStatusBatchRequest = z.infer<typeof fsGitStatusBatchRequestSchema>;

export const fsGitStatusBatchResponseSchema = z.object({
  results: z.record(z.string(), fsGitStatusResponseSchema),
  errors: z.record(z.string(), fsBatchErrorSchema),
});
export type FsGitStatusBatchResponse = z.infer<typeof fsGitStatusBatchResponseSchema>;

export const fsPullRequestBatchRequestSchema = z.object({
  roots: z.array(z.string().min(1)).min(1).max(32),
});
export type FsPullRequestBatchRequest = z.infer<typeof fsPullRequestBatchRequestSchema>;

export const fsPullRequestBatchResponseSchema = z.object({
  results: z.record(z.string(), fsPullRequestSchema.nullable()),
  errors: z.record(z.string(), fsBatchErrorSchema),
});
export type FsPullRequestBatchResponse = z.infer<typeof fsPullRequestBatchResponseSchema>;

export const fsDiffRequestSchema = z.object({
  path: z.string().min(1),
  root: z.string().min(1).optional(),
});
export type FsDiffRequest = z.infer<typeof fsDiffRequestSchema>;

export const fsDiffResponseSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
export type FsDiffResponse = z.infer<typeof fsDiffResponseSchema>;

export interface IGitService {
  readonly _serviceBrand: undefined;

  status(cwd: string, options?: GitStatusOptions): Promise<FsGitStatusResponse>;
  pullRequest(cwd: string): Promise<FsPullRequest | null>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
  findWorkTree(cwd: string): Promise<GitWorkTree | null>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
