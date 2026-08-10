/**
 *   GET    /v1/workspaces                       → ListWorkspacesResponse  { items }
 *   POST   /v1/workspaces                       body: WorkspaceCreate      → Workspace
 *   PATCH  /v1/workspaces/{workspace_id}        body: WorkspaceUpdate      → Workspace
 *   DELETE /v1/workspaces/{workspace_id}                                   → { deleted: true }
 *
 * Errors:
 *   - 40001 validation.failed       (root not absolute, name too long, etc.)
 *   - 40409 fs.path_not_found       (POST /workspaces { root } where root doesn't exist)
 *   - 40410 workspace.not_found     (PATCH/DELETE unknown id)
 */

import { z } from 'zod';

import {
  workspaceCreateSchema,
  workspaceIdSchema,
  workspaceSchema,
  workspaceUpdateSchema,
} from '../workspace';

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
