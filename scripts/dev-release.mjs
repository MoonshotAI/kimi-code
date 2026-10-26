import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = '@moonshot-ai/kimi-code';
const TAG_PREFIX = `${PACKAGE_NAME}@`;
const DEV_RE = /^0\.0\.0-dev\.([1-9]\d*)$/;

export function parseDevVersion(version) {
  const match = DEV_RE.exec(version);
  if (match === null) return null;
  const runNumber = Number(match[1]);
  return Number.isSafeInteger(runNumber) ? { runNumber } : null;
}

export function compareDevVersions(leftVersion, rightVersion) {
  const left = parseDevVersion(leftVersion);
  const right = parseDevVersion(rightVersion);
  if (left === null || right === null) throw new Error(`not dev versions: ${leftVersion}, ${rightVersion}`);
  if (left.runNumber === right.runNumber) return 0;
  return left.runNumber > right.runNumber ? 1 : -1;
}

export function findNewerDevVersion(version, publishedVersions) {
  return publishedVersions
    .filter((published) => compareDevVersions(published, version) > 0)
    .toSorted(compareDevVersions)
    .at(-1) ?? null;
}

export function computeDevVersion(runNumber) {
  if (!Number.isSafeInteger(runNumber) || runNumber <= 0) throw new Error('run number must be a positive integer');
  return `0.0.0-dev.${runNumber}`;
}

export function buildDevRecord({ version, publishedAt }) {
  if (parseDevVersion(version) === null) throw new Error(`invalid dev version ${version}`);
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error(`publishedAt is not a timestamp: ${publishedAt}`);
  return { schemaVersion: 1, version, publishedAt, rollout: [] };
}

const NATIVE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];

export function requiredDevReleaseAssets() {
  return [
    ...NATIVE_TARGETS.flatMap((target) => [
      `kimi-code-${target}.zip`,
      `kimi-code-${target}.zip.sha256`,
      `kimi-code-${target}.zst`,
      `kimi-code-${target}.zst.sha256`,
      `kimi-code-${target}.tar.gz`,
      `kimi-code-${target}.tar.gz.sha256`,
    ]),
    'manifest.json',
    'dev.json',
  ];
}

export function isCompleteDevRelease(release) {
  if (release.isDraft) return false;
  const assets = new Set(release.assets.map((asset) => asset.name));
  return requiredDevReleaseAssets().every((name) => assets.has(name));
}

export function selectDevCommit({ ref, sha, greenShas, devReleases }) {
  if (ref !== 'refs/heads/main') throw new Error(`dev releases only from main, got ${ref}`);
  if (!greenShas.includes(sha)) throw new Error(`latest main commit ${sha} has not passed CI`);
  const published = devReleases.find((release) => release.isComplete);
  if (published !== undefined) {
    return { sha, skip: true, reason: `${sha} already has ${published.tag}` };
  }
  return { sha, skip: false, reason: '' };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeOutputs(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${String(value)}\n`).join('');
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

function devTags() {
  return lines(git(['tag', '--list', `${TAG_PREFIX}*-dev.*`]));
}

function devVersions(tags) {
  return tags
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length))
    .filter((version) => parseDevVersion(version) !== null);
}

export function readDevRelease(tag, view = (releaseTag) => {
  return JSON.parse(execFileSync('gh', ['release', 'view', releaseTag, '--json', 'isDraft,assets'], { encoding: 'utf8' }));
}) {
  try {
    return view(tag);
  } catch (error) {
    const details = error instanceof Error ? `${error.message}\n${error.stderr ?? ''}` : String(error);
    if (/HTTP 404|release not found/i.test(details)) return null;
    throw error;
  }
}

function select() {
  const sha = env('GITHUB_SHA');
  const query = new URLSearchParams({ branch: 'main', event: 'push', status: 'success', per_page: '100' });
  const runs = JSON.parse(execFileSync('gh', ['api', `repos/${env('GITHUB_REPOSITORY')}/actions/workflows/ci.yml/runs?${query}`], { encoding: 'utf8' }));
  const devReleases = lines(git(['tag', '--points-at', sha, '--list', `${TAG_PREFIX}*-dev.*`]))
    .map((tag) => {
      const release = readDevRelease(tag);
      return { tag, isComplete: release !== null && isCompleteDevRelease(release) };
    });
  const result = selectDevCommit({
    ref: env('GITHUB_REF'),
    sha,
    greenShas: runs.workflow_runs.map((run) => run.head_sha),
    devReleases,
  });
  if (result.reason !== '') process.stdout.write(`::notice::skipping dev release: ${result.reason}\n`);
  writeOutputs({ skip: result.skip ? 'true' : 'false', sha: result.sha });
}

function version() {
  const result = computeDevVersion(Number(env('GITHUB_RUN_NUMBER')));
  const tag = `${TAG_PREFIX}${result}`;
  if (devTags().includes(tag) && env('GITHUB_RUN_ATTEMPT') === '1') {
    throw new Error(`${tag} already exists on another commit`);
}
  const run = JSON.parse(execFileSync('gh', ['api', `repos/${env('GITHUB_REPOSITORY')}/actions/runs/${env('GITHUB_RUN_ID')}`], { encoding: 'utf8' }));
  writeOutputs({ version: result, tag, published_at: run.created_at });
}

function guard() {
  git(['fetch', '--tags', 'origin']);
  const publishedVersions = devVersions(devTags());
  if (process.env.KIMI_CODE_DEV_NPM_PUBLISH === 'true') {
    const npmLatest = execFileSync('npm', ['view', PACKAGE_NAME, 'dist-tags.dev'], { encoding: 'utf8' }).trim();
    if (npmLatest !== '') {
      if (parseDevVersion(npmLatest) === null) throw new Error(`npm dev tag is malformed: ${npmLatest}`);
      publishedVersions.push(npmLatest);
    }
  }
  const version = env('DEV_VERSION');
  const newer = findNewerDevVersion(version, publishedVersions);
  if (newer !== null) throw new Error(`stale dev run: ${version} would replace newer ${newer}`);
  process.stdout.write(`dev publish guard passed for ${version}\n`);
}

function record(outDir) {
  const record = buildDevRecord({ version: env('DEV_VERSION'), publishedAt: env('DEV_PUBLISHED_AT') });
  writeFileSync(join(outDir, 'dev.json'), `${JSON.stringify(record, null, 2)}\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'select') select();
  else if (command === 'version') version();
  else if (command === 'guard') guard();
  else if (command === 'record' && arg !== undefined) record(arg);
  else throw new Error(`usage: ${import.meta.filename} select | version | guard | record <out-dir>`);
}
