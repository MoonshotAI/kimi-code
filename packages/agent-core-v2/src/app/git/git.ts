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
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

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

export const fsDiffRequestSchema = z.object({
  path: z.string().min(1),
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

  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
  findWorkTree(cwd: string): Promise<GitWorkTree | null>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
