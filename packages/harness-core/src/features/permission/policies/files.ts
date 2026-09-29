import { isSensitiveFile } from '#/features/os/path-access';

import { findGitWorkTree, hasGitPathComponent, isGitControlPath } from '../analyzers/git';

import type { PermissionPolicy } from './chain';
import { fileAccesses } from './file-access';

export const sensitiveFileAccessAsk: PermissionPolicy = {
  name: 'sensitive-file-access-ask',
  evaluate(context) {
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    return access === undefined ? undefined : { kind: 'ask' };
  },
};

export const gitControlPathAccessAsk: PermissionPolicy = {
  name: 'git-control-path-access-ask',
  async evaluate(context) {
    const cwd = context.workDir ?? '';
    if (cwd.length === 0) return undefined;
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;

    const directGitAccess = accesses.find((fileAccess) =>
      hasGitPathComponent(fileAccess.path, cwd, context.pathClass),
    );
    if (directGitAccess !== undefined) return { kind: 'ask' };

    const marker = await findGitWorkTree(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((fileAccess) =>
      isGitControlPath(fileAccess.path, marker, context.pathClass),
    );
    return access === undefined ? undefined : { kind: 'ask' };
  },
};
