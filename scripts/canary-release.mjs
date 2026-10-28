import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = '@moonshot-ai/kimi-code';
const TAG_PREFIX = `${PACKAGE_NAME}@`;
const CLI_PACKAGE_JSON = new URL('../apps/kimi-code/package.json', import.meta.url);
const BASE_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CANARY_RE = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-canary\.(\d{14})-([0-9a-f]{7})$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export function parseCanaryVersion(version) {
  const match = CANARY_RE.exec(version);
  if (match === null) return null;
  const base = match[1].split('.').map(Number);
  if (!base.every(Number.isSafeInteger)) return null;
  return { base, timestamp: match[2], commit: match[3] };
}

export function compareCanaryVersions(leftVersion, rightVersion) {
  const left = parseCanaryVersion(leftVersion);
  const right = parseCanaryVersion(rightVersion);
  if (left === null || right === null) throw new Error(`not canary versions: ${leftVersion}, ${rightVersion}`);
  const leftKey = [...left.base, left.timestamp, left.commit];
  const rightKey = [...right.base, right.timestamp, right.commit];
  const index = leftKey.findIndex((part, position) => part !== rightKey[position]);
  if (index === -1) return 0;
  return leftKey[index] > rightKey[index] ? 1 : -1;
}

export function findNewerCanaryVersion(version, publishedVersions) {
  return publishedVersions
    .filter((published) => compareCanaryVersions(published, version) > 0)
    .toSorted(compareCanaryVersions)
    .at(-1) ?? null;
}

export function computeCanaryVersion({ baseVersion, publishedAt, sha }) {
  if (!BASE_RE.test(baseVersion)) throw new Error(`canary base must be a plain x.y.z version, got ${baseVersion}`);
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) throw new Error(`publishedAt is not a timestamp: ${publishedAt}`);
  if (!COMMIT_RE.test(sha)) throw new Error(`sha must be a full commit sha, got ${sha}`);
  const timestamp = new Date(published).toISOString().slice(0, 19).replaceAll(/\D/g, '');
  return `${baseVersion}-canary.${timestamp}-${sha.slice(0, 7)}`;
}

export function buildCanaryRecord({ version, publishedAt }) {
  if (parseCanaryVersion(version) === null) throw new Error(`invalid canary version ${version}`);
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error(`publishedAt is not a timestamp: ${publishedAt}`);
  return { schemaVersion: 1, version, publishedAt, rollout: [] };
}

const NATIVE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];

export function requiredCanaryReleaseAssets() {
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
    'canary.json',
  ];
}

export function isCompleteCanaryRelease(release) {
  if (release.isDraft) return false;
  const assets = new Set(release.assets.map((asset) => asset.name));
  return requiredCanaryReleaseAssets().every((name) => assets.has(name));
}

export function selectCanaryCommit({ ref, sha, greenShas, canaryReleases }) {
  if (ref !== 'refs/heads/main') throw new Error(`canary releases only from main, got ${ref}`);
  if (!greenShas.includes(sha)) throw new Error(`latest main commit ${sha} has not passed CI`);
  const published = canaryReleases.find((release) => release.isComplete);
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

function canaryTags() {
  return lines(git(['tag', '--list', `${TAG_PREFIX}*-canary.*`]));
}

function canaryVersions(tags) {
  return tags
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length))
    .filter((version) => parseCanaryVersion(version) !== null);
}

export function readCanaryRelease(tag, view = (releaseTag) => {
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

export function listSuccessfulMainCiShas(repository, execute = execFileSync) {
  const query = new URLSearchParams({ branch: 'main', event: 'push', status: 'success', per_page: '100' });
  return lines(execute('gh', [
    'api',
    `repos/${repository}/actions/workflows/ci.yml/runs?${query}`,
    '--jq',
    '.workflow_runs[].head_sha',
  ], { encoding: 'utf8' }));
}

function select() {
  const sha = env('GITHUB_SHA');
  const greenShas = listSuccessfulMainCiShas(env('GITHUB_REPOSITORY'));
  const canaryReleases = lines(git(['tag', '--points-at', sha, '--list', `${TAG_PREFIX}*-canary.*`]))
    .map((tag) => {
      const release = readCanaryRelease(tag);
      return { tag, isComplete: release !== null && isCompleteCanaryRelease(release) };
    });
  const result = selectCanaryCommit({
    ref: env('GITHUB_REF'),
    sha,
    greenShas,
    canaryReleases,
  });
  if (result.reason !== '') process.stdout.write(`::notice::skipping canary release: ${result.reason}\n`);
  writeOutputs({ skip: result.skip ? 'true' : 'false', sha: result.sha });
}

function version() {
  const run = JSON.parse(execFileSync('gh', ['api', `repos/${env('GITHUB_REPOSITORY')}/actions/runs/${env('GITHUB_RUN_ID')}`], { encoding: 'utf8' }));
  const result = computeCanaryVersion({
    baseVersion: JSON.parse(readFileSync(CLI_PACKAGE_JSON, 'utf8')).version,
    publishedAt: run.created_at,
    sha: env('GITHUB_SHA'),
  });
  const tag = `${TAG_PREFIX}${result}`;
  if (canaryTags().includes(tag) && env('GITHUB_RUN_ATTEMPT') === '1') {
    throw new Error(`${tag} already exists before this run`);
  }
  writeOutputs({ version: result, tag, published_at: run.created_at });
}

function guard() {
  git(['fetch', '--tags', 'origin']);
  const publishedVersions = canaryVersions(canaryTags());
  if (process.env.KIMI_CODE_CANARY_NPM_PUBLISH === 'true') {
    const npmLatest = execFileSync('npm', ['view', PACKAGE_NAME, 'dist-tags.canary'], { encoding: 'utf8' }).trim();
    if (npmLatest !== '') {
      if (parseCanaryVersion(npmLatest) === null) throw new Error(`npm canary tag is malformed: ${npmLatest}`);
      publishedVersions.push(npmLatest);
    }
  }
  const version = env('CANARY_VERSION');
  const newer = findNewerCanaryVersion(version, publishedVersions);
  if (newer !== null) throw new Error(`stale canary run: ${version} would replace newer ${newer}`);
  process.stdout.write(`canary publish guard passed for ${version}\n`);
}

function record(outDir) {
  const record = buildCanaryRecord({ version: env('CANARY_VERSION'), publishedAt: env('CANARY_PUBLISHED_AT') });
  writeFileSync(join(outDir, 'canary.json'), `${JSON.stringify(record, null, 2)}\n`);
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
