import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMMIT_OPTIONS = [
  '-c',
  'user.email=dev@example.com',
  '-c',
  'user.name=Dev',
  '-c',
  'commit.gpgsign=false',
];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd();
}

export function commit(cwd: string, message: string): void {
  git(cwd, ...COMMIT_OPTIONS, 'commit', '-q', '-m', message);
}

export function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '.');
  commit(cwd, message);
}

export async function initRepo(root: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  commitAll(root, 'init');
  return root;
}

export interface RepoTemplate {
  copyTo(root: string): Promise<string>;
  dispose(): Promise<void>;
}

export async function createRepoTemplate(files: Readonly<Record<string, string>>): Promise<RepoTemplate> {
  const template = await initRepo(await mkdtemp(join(tmpdir(), 'kimi-git-template-')), files);
  return {
    copyTo: async (root) => {
      await cp(template, root, { recursive: true });
      return root;
    },
    dispose: () => rm(template, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export function hangingRemote(root: string): void {
  git(root, 'config', 'protocol.ext.allow', 'always');
  git(root, 'remote', 'add', 'origin', 'ext::sleep 30');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}
