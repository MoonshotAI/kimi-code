import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestkitError } from '#/errors';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export function repoPath(...segments: readonly string[]): string {
  if (!existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))) throw new TestkitError(`testkit could not find the repository root at ${REPO_ROOT}`);
  return join(REPO_ROOT, ...segments);
}
