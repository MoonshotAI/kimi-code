import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const repo = process.env.GITHUB_REPOSITORY;
const branch = process.env.GITHUB_REF_NAME;
const sha = process.env.GITHUB_SHA;
if (process.env.GITHUB_EVENT_NAME !== 'push' || !branch?.startsWith('release/') || process.env.GITHUB_REF !== `refs/heads/${branch}`) {
  throw new Error('Automatic publication requires a release branch push');
}
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('GITHUB_SHA must be a full commit SHA');
const pages = JSON.parse(execFileSync('gh', [
  'api', `repos/${repo}/commits/${sha}/pulls?per_page=100`, '--paginate', '--slurp',
], { encoding: 'utf8' }));
const versionPR = pages.flat().find(pr => pr.merged_at && pr.merge_commit_sha === sha
  && pr.base.ref === branch && pr.base.repo.full_name === repo
  && pr.head.ref === `changeset-release/${branch}` && pr.head.repo?.full_name === repo);
if (!versionPR) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'publish=false\n');
  process.exit(0);
}
const query = new URLSearchParams({ head_sha: sha, branch, event: 'push', per_page: '100' });
let run;
for (let attempt = 0; attempt < 18; attempt++) {
  const result = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?${query}`], { encoding: 'utf8' }));
  run = result.workflow_runs.filter(item => item.head_sha === sha && item.head_branch === branch && item.event === 'push')
    .toSorted((a, b) => b.id - a.id)[0];
  if (run) break;
  await setTimeout(10_000);
}
if (!run) throw new Error('No push CI run found for the merged version commit');
execFileSync('gh', ['run', 'watch', String(run.id), '--repo', repo, '--exit-status', '--interval', '10'], { stdio: 'inherit' });
appendFileSync(process.env.GITHUB_OUTPUT, 'publish=true\n');
