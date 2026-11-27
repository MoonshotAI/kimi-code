import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const repo = process.env.GITHUB_REPOSITORY;
const branch = process.env.GITHUB_REF_NAME;
const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA;
if (!['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) || !branch?.startsWith('release/') || process.env.GITHUB_REF !== `refs/heads/${branch}`) {
  throw new Error('Publication requires a release branch run');
}
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Release SHA must be a full commit SHA');
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
appendFileSync(process.env.GITHUB_OUTPUT, 'publish=true\n');
