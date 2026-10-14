import { appendFileSync, readFileSync } from 'node:fs';

const branch = process.env.GITHUB_REF_NAME;
if (!branch?.startsWith('release/') || process.env.GITHUB_REF !== `refs/heads/${branch}`) throw new Error('Select a release branch');
const plan = JSON.parse(readFileSync('.changeset/release-plan.json', 'utf8'));
if (plan.branch !== branch) throw new Error('Release plan belongs to another branch');
const entry = plan.packages.find(pkg => pkg.path === 'apps/vscode');
if (!entry) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'publish=false\n');
} else {
  const pkg = JSON.parse(readFileSync('apps/vscode/package.json', 'utf8'));
  if (entry.name !== pkg.name || entry.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Stale extension release plan');
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=true\nversion=${pkg.version}\n`);
}
