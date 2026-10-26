// Canary release helper for .github/workflows/canary.yml.
//
//   select   pick the newest CI-green commit on main and decide whether to build it
//   version  compute the canary version for the selected commit checked out in <source-dir>
//   record   write the canary.json GitHub prerelease asset and release notes
//
// Version format: <major>.<minor>.<patch>-canary.<YYYYMMDDHHmm UTC>. The base is
// the highest of the planned next release, the next patch after npm `latest`,
// and the previous canary's base, so every canary sorts above the stable
// release of its day and above the previous canary.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = '@moonshot-ai/kimi-code';
const TAG_PREFIX = `${PACKAGE_NAME}@`;
const NUMBER = '(0|[1-9]\\d*)';
const RELEASE_RE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const CANARY_RE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}-canary\\.(\\d{12})$`);

function parseRelease(version) {
  const match = RELEASE_RE.exec(version);
  if (match === null) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  return match.slice(1, 4).map(Number);
}

export function parseCanaryVersion(version) {
  const match = CANARY_RE.exec(version);
  if (match === null) return null;
  return { base: match.slice(1, 4).join('.'), stamp: match[4] };
}

function compareRelease(leftVersion, rightVersion) {
  const left = parseRelease(leftVersion);
  const right = parseRelease(rightVersion);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function compareCanaryVersions(leftVersion, rightVersion) {
  const left = parseCanaryVersion(leftVersion);
  const right = parseCanaryVersion(rightVersion);
  if (left === null || right === null) throw new Error(`not canary versions: ${leftVersion}, ${rightVersion}`);
  return compareRelease(left.base, right.base) || left.stamp.localeCompare(right.stamp);
}

function nextPatch(version) {
  const [major, minor, patch] = parseRelease(version);
  return `${major}.${minor}.${patch + 1}`;
}

export function canaryStamp(date) {
  return date.toISOString().replaceAll(/[-:T]/g, '').slice(0, 12);
}

export function computeCanaryVersion({ plannedNext, packageVersion, stableLatest, previousCanary, builtAt }) {
  const candidates = [plannedNext ?? nextPatch(packageVersion), nextPatch(stableLatest)];
  if (previousCanary !== null) {
    const previous = parseCanaryVersion(previousCanary);
    if (previous === null) throw new Error(`previous canary is malformed: ${previousCanary}`);
    candidates.push(previous.base);
  }
  const base = candidates.reduce((best, candidate) => (compareRelease(candidate, best) > 0 ? candidate : best));
  return `${base}-canary.${canaryStamp(builtAt)}`;
}

export function latestCanaryFromTags(tags) {
  const versions = tags
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length))
    .filter((version) => parseCanaryVersion(version) !== null)
    .toSorted(compareCanaryVersions);
  return versions.at(-1) ?? null;
}

export function pickNewestGreenCommit(firstParentShas, greenShas) {
  const green = new Set(greenShas);
  return firstParentShas.find((sha) => green.has(sha)) ?? null;
}

export function parseChangeset(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) return null;
  const packages = [...match[1].matchAll(/^\s*["']?([^"':\s]+)["']?\s*:\s*(\w+)\s*$/gm)]
    .map((packageMatch) => packageMatch[1]);
  return { packages, summary: match[2].trim().replaceAll(/\s+/g, ' ') };
}

export function canaryChanges(currentChangesets, previousNames) {
  const changes = [];
  const byName = [...currentChangesets].toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName));
  for (const [name, content] of byName) {
    if (previousNames.has(name)) continue;
    const parsed = parseChangeset(content);
    if (parsed !== null && parsed.packages.includes(PACKAGE_NAME) && parsed.summary !== '') {
      changes.push(parsed.summary);
    }
  }
  return changes;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function writeOutputs(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${String(value)}\n`).join('');
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

function canaryTags() {
  return lines(git(['tag', '--list', `${TAG_PREFIX}*-canary.*`]));
}

function changesetsAt(ref) {
  const names = lines(git(['ls-tree', '--name-only', `${ref}:.changeset`]))
    .filter((name) => name.endsWith('.md') && name !== 'README.md');
  return new Map(names.map((name) => [name, git(['show', `${ref}:.changeset/${name}`])]));
}

function select() {
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error(`canary builds only from main, got ${process.env.GITHUB_REF}`);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const query = new URLSearchParams({ branch: 'main', event: 'push', status: 'success', per_page: '100' });
  const runs = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?${query}`], { encoding: 'utf8' }));
  const firstParent = lines(git(['rev-list', '--first-parent', '--max-count=500', 'origin/main']));
  const sha = pickNewestGreenCommit(firstParent, runs.workflow_runs.map((run) => run.head_sha));
  if (sha === null) throw new Error('no CI-green commit found on main');

  const force = process.env.CANARY_FORCE === 'true';
  const built = lines(git(['tag', '--points-at', sha, '--list', `${TAG_PREFIX}*-canary.*`]));
  const previous = latestCanaryFromTags(canaryTags());
  let reason = '';
  if (!force && built.length > 0) {
    reason = `${sha} already has ${built.join(', ')}`;
  } else if (!force && previous !== null) {
    const previousSha = git(['rev-list', '-n', '1', `${TAG_PREFIX}${previous}`]);
    const isOlder = spawnSync('git', ['merge-base', '--is-ancestor', sha, previousSha]).status === 0;
    if (isOlder) reason = `${sha} is not newer than the previous canary ${previous}`;
  }
  if (reason !== '') process.stdout.write(`::notice::skipping canary: ${reason}\n`);
  writeOutputs({ skip: reason === '' ? 'false' : 'true', sha });
}

async function version(sourceDir) {
  const require = createRequire(import.meta.url);
  const changesetsRequire = createRequire(require.resolve('@changesets/cli/package.json'));
  const loaded = changesetsRequire('@changesets/get-release-plan');
  const getReleasePlan = loaded.default ?? loaded;
  const plan = await getReleasePlan(sourceDir);
  const plannedNext = plan.releases.find((release) => release.name === PACKAGE_NAME)?.newVersion ?? null;
  const packageVersion = JSON.parse(readFileSync(join(sourceDir, 'apps/kimi-code/package.json'), 'utf8')).version;
  const stableLatest = execFileSync('npm', ['view', PACKAGE_NAME, 'dist-tags.latest'], { encoding: 'utf8' }).trim();
  const builtAt = new Date();
  const result = computeCanaryVersion({
    plannedNext,
    packageVersion,
    stableLatest,
    previousCanary: latestCanaryFromTags(canaryTags()),
    builtAt,
  });
  const tag = `${TAG_PREFIX}${result}`;
  if (canaryTags().includes(tag)) throw new Error(`${tag} already exists`);
  writeOutputs({ version: result, tag, built_at: builtAt.toISOString() });
}

function record(outDir) {
  const env = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const versionValue = env('CANARY_VERSION');
  if (parseCanaryVersion(versionValue) === null) throw new Error(`invalid canary version ${versionValue}`);
  const commit = env('CANARY_SHA');
  const previous = latestCanaryFromTags(canaryTags().filter((tag) => tag !== `${TAG_PREFIX}${versionValue}`));
  const previousNames = previous === null
    ? new Set()
    : new Set(changesetsAt(`${TAG_PREFIX}${previous}`).keys());
  const changes = canaryChanges(changesetsAt(commit), previousNames);
  const buildRecord = {
    version: versionValue,
    rollout: [],
    channel: 'canary',
    commit,
    ref: env('CANARY_REF'),
    trigger: env('CANARY_TRIGGER'),
    builtAt: env('CANARY_BUILT_AT'),
    changes,
  };
  writeFileSync(join(outDir, 'canary.json'), `${JSON.stringify(buildRecord, null, 2)}\n`);
  const notes = [
    `Canary build of ${PACKAGE_NAME} from \`${buildRecord.ref}\` @ ${commit}.`,
    '',
    previous === null ? '## Changes' : `## Changes since ${previous}`,
    '',
    ...(changes.length === 0 ? ['- No user-facing changes.'] : changes.map((change) => `- ${change}`)),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'notes.md'), notes);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'select') select();
  else if (command === 'version' && arg !== undefined) await version(arg);
  else if (command === 'record' && arg !== undefined) record(arg);
  else throw new Error(`usage: ${import.meta.filename} select | version <source-dir> | record <out-dir>`);
}
