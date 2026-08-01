/**
 * `workspaceContext` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkspaceContextErrors = {
  codes: {
    WORKSPACE_CONTEXT_PATH_ESCAPES: 'workspace_context.path_escapes',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceContextErrors);
