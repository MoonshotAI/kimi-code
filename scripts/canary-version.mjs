import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCanaryVersion, parseCanaryVersion } from './canary-release.mjs';

const pkgPath = 'apps/desktop/package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (process.argv.includes('--stamp')) {
  const version = process.env.CANARY_VERSION;
  const legacy = /^\d+\.\d+\.\d+-canary\.\d+\.\d+\.g[0-9a-f]{8}$/.test(version ?? '');
  if (!legacy && parseCanaryVersion(version ?? '') === null) throw new Error('Invalid Canary version');
  pkg.version = version;
  pkg.canarySourceBranch = process.env.GITHUB_REF_NAME ?? '';
  pkg.canarySourceCommit = process.env.GITHUB_SHA ?? '';
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
} else {
  const branch = process.env.GITHUB_REF_NAME ?? '';
  let target = process.env.CANARY_TARGET_VERSION?.trim();
  const changesetNames = () => readdirSync('.changeset').filter((name) => name.endsWith('.md') && name !== 'README.md');
  const resolveChangesetVersion = () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-plan-'));
    try {
      const output = join(dir, 'status.json');
      execFileSync('pnpm', ['changeset', 'status', '--output', output], { stdio: ['ignore', 'ignore', 'inherit'] });
      const status = JSON.parse(readFileSync(output, 'utf8'));
      return status.releases.find((entry) => entry.name === 'kimi-code-app')?.newVersion;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  if (branch.startsWith('release/')) {
    let calculated;
    if (changesetNames().length > 0) {
      calculated = resolveChangesetVersion();
    } else if (existsSync('.changeset/release-plan.json')) {
      const plan = JSON.parse(readFileSync('.changeset/release-plan.json', 'utf8'));
      const planned = plan.branch === branch ? plan.packages.find((entry) => entry.name === 'kimi-code-app') : undefined;
      if (planned?.version === pkg.version) calculated = planned.version;
    }
    if (!calculated) throw new Error('No desktop changesets or matching release plan');
    if (target && target !== calculated) throw new Error('Target version differs from release plan');
    target = calculated;
  } else if (branch === 'main' && !target) {
    if (changesetNames().length > 0) target = resolveChangesetVersion();
    if (!target) {
      const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
      if (stable) target = `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}`;
    }
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target ?? '')) throw new Error('Set a stable Canary target version');
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!/^[^/]+\/[^/]+$/.test(repository ?? '') || !/^[1-9]\d*$/.test(runId ?? '')) throw new Error('Invalid build identity');
  const run = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { encoding: 'utf8' }));
  const version = computeCanaryVersion({ baseVersion: target, publishedAt: run.created_at, sha: process.env.GITHUB_SHA });
  process.stdout.write(`version=${version}\n`);
}
