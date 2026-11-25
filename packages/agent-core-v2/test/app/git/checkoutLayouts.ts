import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

export interface LayoutLab {
  readonly base: string;
  dir(...segments: string[]): string;
  dispose(): void;
}

export function createLayoutLab(prefix: string): LayoutLab {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    base,
    dir: (...segments) => ensureDir(join(base, ...segments)),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface PointerStyle {
  readonly relative?: boolean;
  readonly lineEnding?: '\n' | '\r\n';
  readonly bom?: boolean;
}

export function mainCheckout(path: string): string {
  writeRepositoryDir(join(ensureDir(path), '.git'), false);
  return path;
}

export function bareRepository(path: string): string {
  writeRepositoryDir(ensureDir(path), true);
  return path;
}

export function bareContainer(container: string): string {
  const bare = bareRepository(join(ensureDir(container), '.bare'));
  writeFileSync(join(container, '.git'), 'gitdir: ./.bare\n');
  return bare;
}

export function linkedWorktree(commonDir: string, worktree: string, style: PointerStyle = {}): string {
  ensureDir(worktree);
  const meta = ensureDir(join(commonDir, 'worktrees', basename(worktree)));
  const realMeta = realpathSync(meta);
  const realWorktree = realpathSync(worktree);
  writeFileSync(join(meta, 'HEAD'), `ref: refs/heads/${basename(worktree)}\n`);
  writeFileSync(join(meta, 'commondir'), '../..\n');
  writeFileSync(
    join(meta, 'gitdir'),
    `${style.relative === true ? relative(realMeta, join(realWorktree, '.git')) : join(realWorktree, '.git')}\n`,
  );
  const target = style.relative === true ? relative(realWorktree, realMeta) : realMeta;
  writeFileSync(join(worktree, '.git'), `${style.bom === true ? '\uFEFF' : ''}gitdir: ${target}${style.lineEnding ?? '\n'}`);
  return worktree;
}

export function submodule(superproject: string, name: string): string {
  const modules = join(superproject, '.git', 'modules', name);
  writeRepositoryDir(ensureDir(modules), false, `../../../${name}`);
  const checkout = ensureDir(join(superproject, name));
  writeFileSync(join(checkout, '.git'), `gitdir: ${relative(checkout, modules)}\n`);
  writeFileSync(join(superproject, '.gitmodules'), `[submodule "${name}"]\n\tpath = ${name}\n\turl = ../${name}\n`);
  return modules;
}

export function separateGitDirCheckout(checkout: string, gitDir: string): string {
  writeRepositoryDir(ensureDir(gitDir), false);
  writeFileSync(join(ensureDir(checkout), '.git'), `gitdir: ${realpathSync(gitDir)}\n`);
  return gitDir;
}

export function forgedPointer(path: string, gitDir: string): string {
  writeFileSync(join(ensureDir(path), '.git'), `gitdir: ${realpathSync(gitDir)}\n`);
  return path;
}

export function forgedCoreWorktree(attacker: string, victim: string): string {
  const fake = join(attacker, 'fake.git');
  writeRepositoryDir(ensureDir(fake), false, realpathSync(victim));
  return linkedWorktree(fake, join(attacker, 'w'));
}

function writeRepositoryDir(gitDir: string, bare: boolean, worktree?: string): void {
  ensureDir(join(gitDir, 'refs', 'heads'));
  ensureDir(join(gitDir, 'objects'));
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  const lines = ['[core]', '\trepositoryformatversion = 0', `\tbare = ${bare}`];
  if (worktree !== undefined) lines.push(`\tworktree = ${worktree}`);
  writeFileSync(join(gitDir, 'config'), `${lines.join('\n')}\n`);
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
