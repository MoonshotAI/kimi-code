import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ProjectErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
    WORKSPACE_PRIMARY_IMMUTABLE: 'workspace.primary_immutable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProjectErrors);
