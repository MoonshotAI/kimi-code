import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestHome {
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  readonly workspace: string;
  remove(): Promise<void>;
}

export async function createTestHome(prefix = 'testkit'): Promise<TestHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), `${prefix}-`));
  const home = join(root, 'home');
  const dataDir = join(root, 'kimi-code-home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(dataDir), mkdir(workspace)]);
  return {
    root,
    home,
    dataDir,
    workspace,
    remove: () => removeDirectory(root),
  };
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
