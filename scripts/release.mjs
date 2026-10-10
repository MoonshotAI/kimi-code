import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const command = process.argv[2];
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const branch = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF !== `refs/heads/${branch}` || !branch?.startsWith('release/')) {
  throw new Error('Select a release/* branch');
}
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || process.env.EXPECTED_SHA !== sha) {
  throw new Error('expected_sha must equal the selected branch commit');
}
const plan = JSON.parse(readFileSync('.changeset/release-plan.json', 'utf8'));
if (plan.branch !== branch || !Array.isArray(plan.packages) || plan.packages.length === 0) {
  throw new Error('Merge the version PR for this release branch first');
}
const pending = readdirSync('.changeset').filter((name) => name.endsWith('.md') && name !== 'README.md');
if (pending.length > 0) throw new Error(`Unconsumed changesets: ${pending.join(', ')}`);
for (const pkg of plan.packages) {
  const current = JSON.parse(readFileSync(`${pkg.path}/package.json`, 'utf8'));
  if (current.name !== pkg.name || current.version !== pkg.version || (current.private === true) !== pkg.private) {
    throw new Error(`Release plan no longer matches ${pkg.path}`);
  }
}
const packages = plan.packages.filter((pkg) => !pkg.private);


function api(endpoint, args = []) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`, ...args], { encoding: 'utf8' }));
}

function optionalApi(endpoint) {
  const result = spawnSync('gh', ['api', `repos/${repo}/${endpoint}`], { encoding: 'utf8' });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (result.stderr.includes('(HTTP 404)')) return undefined;
  throw new Error(result.stderr.length > 0 ? result.stderr : 'GitHub API request failed');
}

function findRelease(tag) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){isDraft}}}';
  const result = JSON.parse(execFileSync('gh', [
    'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`,
  ], { encoding: 'utf8' }));
  if (!result.data?.repository) throw new Error('Cannot read repository releases');
  return result.data.repository.release;
}

function tagFor(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

function verifyTag(tag) {
  let object = optionalApi(`git/ref/tags/${encodeURIComponent(tag)}`)?.object;
  if (!object) return false;
  while (object.type === 'tag') object = api(`git/tags/${object.sha}`).object;
  if (object.type !== 'commit' || object.sha !== sha) throw new Error(`Tag ${tag} belongs to another commit`);
  return true;
}

if (command === 'check') {
  const query = new URLSearchParams({ head_sha: sha, branch, per_page: '100' });
  const runs = api(`actions/workflows/ci.yml/runs?${query}`).workflow_runs
    .filter((run) => run.head_sha === sha && run.head_branch === branch && ['push', 'workflow_dispatch'].includes(run.event))
    .toSorted((a, b) => b.id - a.id);
  if (runs[0]?.status !== 'completed' || runs[0]?.conclusion !== 'success') {
    throw new Error('The latest CI run for this release commit must succeed before publishing');
  }
  for (const pkg of packages) verifyTag(tagFor(pkg));
} else if (command === 'prepare') {
  appendFileSync(process.env.GITHUB_OUTPUT, `npm=${packages.length > 0}\n`);
  for (const pkg of packages) {
    const tag = tagFor(pkg);
    if (!verifyTag(tag)) api('git/refs', ['-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
    let release = findRelease(tag);
    if (!release) {
      const changelog = readFileSync(`${pkg.path}/CHANGELOG.md`, 'utf8');
      const heading = `## ${pkg.version}`;
      const sections = changelog.split(/(?=^## )/m);
      const notes = sections.find((section) => section.split(/\r?\n/, 1)[0] === heading);
      if (!notes) throw new Error(`Missing changelog entry for ${tag}`);
      execFileSync('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', tag, '--notes-file', '-', ...(pkg.version.includes('-') ? ['--prerelease'] : [])], { input: notes, stdio: ['pipe', 'inherit', 'inherit'] });
      release = findRelease(tag);
      if (!release) throw new Error(`Release ${tag} was not created`);
    }
    if (pkg.name === '@moonshot-ai/kimi-code') {
      appendFileSync(process.env.GITHUB_OUTPUT, `build=${release.isDraft}\ntag=${tag}\n`);
    }
  }
} else if (command === 'finish') {
  for (const pkg of packages) {
    if (!verifyTag(tagFor(pkg))) throw new Error(`Missing tag for ${pkg.name}`);
    const release = findRelease(tagFor(pkg));
    if (!release) throw new Error(`Missing release for ${pkg.name}`);
    if (release.isDraft) execFileSync('gh', ['release', 'edit', tagFor(pkg), '--repo', repo, '--draft=false'], { stdio: 'inherit' });
  }
} else {
  throw new Error(`Unknown release command: ${command}`);
}
