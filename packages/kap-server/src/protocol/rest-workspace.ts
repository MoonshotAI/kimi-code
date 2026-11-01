import { z } from 'zod';

import {
  workspaceCreateSchema,
  workspaceIdSchema,
  workspaceSchema,
  workspaceUpdateSchema,
} from './workspace';

export const listWorkspacesResponseSchema = z.object({
  items: z.array(workspaceSchema),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>;

export const createWorkspaceRequestSchema = workspaceCreateSchema;
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const createWorkspaceResponseSchema = workspaceSchema;
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

export const workspaceIdParamSchema = z.object({
  workspace_id: workspaceIdSchema,
});
export type WorkspaceIdParam = z.infer<typeof workspaceIdParamSchema>;

export const updateWorkspaceRequestSchema = workspaceUpdateSchema;
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const updateWorkspaceResponseSchema = workspaceSchema;
export type UpdateWorkspaceResponse = z.infer<typeof updateWorkspaceResponseSchema>;

export const deleteWorkspaceResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteWorkspaceResponse = z.infer<typeof deleteWorkspaceResponseSchema>;

export const workspaceTrustResponseSchema = z.object({
  trusted: z.boolean(),
});
export type WorkspaceTrustResponse = z.infer<typeof workspaceTrustResponseSchema>;

export const setPrimaryRequestSchema = z.object({
  path: z.string().min(1),
});
export type SetPrimaryRequest = z.infer<typeof setPrimaryRequestSchema>;

export const setPrimaryResponseSchema = workspaceSchema;
export type SetPrimaryResponse = z.infer<typeof setPrimaryResponseSchema>;

export const projectConfigDirsQuerySchema = z.object({
  root: z.string().min(1),
});
export type ProjectConfigDirsQuery = z.infer<typeof projectConfigDirsQuerySchema>;

export const projectConfigDirsResponseSchema = z.object({
  additional_dirs: z.array(z.string()),
});
export type ProjectConfigDirsResponse = z.infer<typeof projectConfigDirsResponseSchema>;
