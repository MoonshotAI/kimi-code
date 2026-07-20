import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkspaceErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceErrors);
