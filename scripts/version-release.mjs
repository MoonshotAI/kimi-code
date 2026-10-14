import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const branch = process.env.GITHUB_REF_NAME;
if (!branch?.startsWith('release/')) throw new Error('Select a release/* branch');
const changesets = readdirSync('.changeset').filter((name) => name.endsWith('.md') && name !== 'README.md');
const workspace = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { encoding: 'utf8' }));
const before = workspace.map(({ path }) => {
  const directory = relative(process.cwd(), path).replaceAll('\\', '/');
  return {
    ...JSON.parse(readFileSync(`${path}/package.json`, 'utf8')),
    path: directory === '' ? '.' : directory,
  };
});
execFileSync('pnpm', ['changeset', 'version'], { stdio: 'inherit' });
const packages = before.flatMap((pkg) => {
  const next = JSON.parse(readFileSync(`${pkg.path}/package.json`, 'utf8'));
  return next.version === pkg.version ? [] : [{
    name: next.name,
    path: pkg.path,
    version: next.version,
    private: next.private === true,
  }];
});
if (packages.length > 0) {
  writeFileSync('.changeset/release-plan.json', `${JSON.stringify({ branch, changesets, packages }, null, 2)}\n`);
}
