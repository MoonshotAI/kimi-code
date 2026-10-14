import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const command = process.argv[2];
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const branch = process.env.GITHUB_REF_NAME;
const inputDir = resolve('.release-inputs');
const snapshot = resolve('release-inputs.tar.gz');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const cliName = '@moonshot-ai/kimi-code';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = (path, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(readFileSync(path)).digest(encoding);
function run(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', ...options });
}
function api(endpoint, args = []) {
  return JSON.parse(run('gh', ['api', `repos/${repo}/${endpoint}`, ...args]));
}
function optionalApi(endpoint) {
  const result = spawnSync('gh', ['api', `repos/${repo}/${endpoint}`], { encoding: 'utf8' });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (result.stderr.includes('(HTTP 404)')) return undefined;
  throw new Error(result.stderr || 'GitHub API failed');
}
function output(key, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
if (!branch?.startsWith('release/') || process.env.GITHUB_REF !== `refs/heads/${branch}` || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
  throw new Error('Select a release branch commit');
}
const plan = json('.changeset/release-plan.json');
if (plan.branch !== branch || !Array.isArray(plan.packages) || plan.packages.length === 0) throw new Error('Merge the release version PR first');
for (const pkg of plan.packages) {
  if (!/^(apps|packages)\/[a-zA-Z0-9_-]+$/.test(pkg.path) || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Invalid release package');
  const actual = json(`${pkg.path}/package.json`);
  if (actual.name !== pkg.name || actual.version !== pkg.version || (actual.private === true) !== pkg.private) throw new Error(`Stale release plan: ${pkg.name}`);
}
if (readdirSync('.changeset').some(name => name.endsWith('.md') && name !== 'README.md')) throw new Error('Unconsumed changesets');
const cli = plan.packages.find(pkg => pkg.name === cliName && pkg.path === 'apps/kimi-code' && !pkg.private);
if (!cli) throw new Error('Release plan must include the CLI package');
if (plan.packages.some(pkg => !pkg.private && pkg !== cli)) throw new Error('Only CLI npm publication is supported');
const tag = `${cli.name}@${cli.version}`;
function verifyTag(create = false) {
  const tagName = tag;
  let object = optionalApi(`git/ref/tags/${encodeURIComponent(tagName)}`)?.object;
  if (!object && create) {
    api('git/refs', ['-f', `ref=refs/tags/${tagName}`, '-f', `sha=${sha}`]);
    return;
  }
  while (object?.type === 'tag') object = api(`git/tags/${object.sha}`).object;
  if (object && (object.type !== 'commit' || object.sha !== sha)) throw new Error(`Tag belongs to another commit: ${tagName}`);
  if (!object && !create) throw new Error(`Missing tag: ${tagName}`);
}
function getRelease() {
  const result = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'databaseId'], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (result.stderr.trim() === 'release not found') return undefined;
    throw new Error(result.stderr || 'Cannot read release');
  }
  const id = JSON.parse(result.stdout).databaseId;
  const release = api(`releases/${id}`);
  release.assets = api(`releases/${id}/assets?per_page=100`, ['--paginate', '--slurp']).flat();
  return release;
}
function download(name, dir) {
  mkdirSync(dir, { recursive: true });
  run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber']);
}
function loadInputs() {
  const state = json(`${inputDir}/state.json`);
  if (state.sha !== sha || JSON.stringify(state.plan) !== JSON.stringify(plan)) throw new Error('Release inputs belong to another commit or plan');
  if (state.package.name !== cli.name || state.package.version !== cli.version) throw new Error('Saved npm package does not match plan');
  if (!state.files['catalog.json']) throw new Error('Missing saved catalog');
  if (state.package.file !== 'package.tgz' || state.package.integrity !== `sha512-${hash(`${inputDir}/package.tgz`, 'sha512', 'base64')}`) throw new Error('Invalid saved npm package');
  for (const [file, digest] of Object.entries(state.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(file) || hash(`${inputDir}/${file}`) !== digest) throw new Error(`Invalid release input: ${file}`);
  }
  return state;
}
if (command === 'check') {
  const query = new URLSearchParams({ head_sha: sha, branch, per_page: '100' });
  const runs = api(`actions/workflows/ci.yml/runs?${query}`).workflow_runs
    .filter(item => item.head_sha === sha && item.head_branch === branch && item.event === 'push')
    .toSorted((a, b) => b.id - a.id);
  if (runs[0]?.status !== 'completed' || runs[0]?.conclusion !== 'success') throw new Error('Merged commit CI must succeed');
} else if (command === 'restore') {
  verifyTag(true);
  let release = getRelease();
  if (!release) {
    run('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', tag, '--notes', `Release ${tag} from ${sha}`]);
    release = getRelease();
  }
  if (!release.draft) {
    output('complete', true);
    process.exit(0);
  }
  mkdirSync(inputDir, { recursive: true });
  const stored = release.assets.find(asset => asset.name === 'release-inputs.tar.gz');
  if (stored) {
    download('release-inputs.tar.gz', process.cwd());
    if (stored.digest !== `sha256:${hash(snapshot)}`) throw new Error('Release input archive checksum mismatch');
    run('tar', ['-xzf', snapshot, '-C', inputDir]);
    loadInputs();
  } else {
    const pkg = cli;
    const result = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' });
    if (result.status === 0) throw new Error('Published npm version has no saved inputs');
    let error;
    try { error = JSON.parse(result.stdout).error; } catch { error = undefined; }
    if (error?.code !== 'E404') throw new Error(result.stderr || 'npm registry lookup failed');
  }
  output('ready', Boolean(stored));
  output('complete', !release.draft);
  output('tag', tag);
} else if (command === 'snapshot') {
  const files = { 'catalog.json': hash(`${inputDir}/catalog.json`) };
  const destination = `${inputDir}/pack`;
  mkdirSync(destination, { recursive: true });
  run('pnpm', ['--dir', cli.path, 'pack', '--pack-destination', destination], { stdio: 'inherit' });
  const tarballs = readdirSync(destination).filter(name => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error('Expected one CLI tarball');
  writeFileSync(`${inputDir}/package.tgz`, readFileSync(`${destination}/${tarballs[0]}`));
  files['package.tgz'] = hash(`${inputDir}/package.tgz`);
  const pkg = { name: cli.name, version: cli.version, file: 'package.tgz', integrity: `sha512-${hash(`${inputDir}/package.tgz`, 'sha512', 'base64')}` };
  writeFileSync(`${inputDir}/state.json`, `${JSON.stringify({ sha, plan, files, package: pkg }, null, 2)}\n`);
  run('tar', ['-czf', snapshot, '-C', inputDir, 'state.json', ...Object.keys(files)]);
  run('gh', ['release', 'upload', tag, snapshot, '--repo', repo]);
} else if (command === 'npm') {
  const state = loadInputs();
  const pkg = state.package;
  const result = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' });
  if (result.status === 0) {
    if (JSON.parse(result.stdout) !== pkg.integrity) throw new Error(`Existing npm content differs: ${pkg.name}@${pkg.version}`);
    process.exit(0);
  }
  let error;
  try { error = JSON.parse(result.stdout).error; } catch { error = undefined; }
  if (error?.code !== 'E404') throw new Error(result.stderr || 'npm registry lookup failed');
  const latest = spawnSync('npm', ['view', pkg.name, 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' });
  if (latest.status === 0) {
    const value = JSON.parse(latest.stdout || 'null');
    if (value && /^\d+\.\d+\.\d+$/.test(value)) {
      const current = value.split('.').map(Number);
      const next = pkg.version.split('.').map(Number);
      const difference = current.map((part, index) => part - next[index]).find(part => part !== 0) ?? 0;
      if (difference > 0) throw new Error(`Refusing to roll back npm latest: ${pkg.name}`);
    } else if (value) throw new Error(`Cannot compare npm latest: ${pkg.name}`);
  } else {
    let error;
    try { error = JSON.parse(latest.stdout).error; } catch { error = undefined; }
    if (error?.code !== 'E404') throw new Error(latest.stderr || 'npm latest lookup failed');
  }
  run('npm', ['publish', `${inputDir}/${pkg.file}`, '--access', 'public', '--provenance', '--registry=https://registry.npmjs.org'], { stdio: 'inherit' });
} else if (command === 'catalog') {
  verifyTag();
  download('release-inputs.tar.gz', process.cwd());
  const stored = getRelease().assets.find(asset => asset.name === 'release-inputs.tar.gz');
  if (stored?.digest !== `sha256:${hash(snapshot)}`) throw new Error('Release input archive checksum mismatch');
  mkdirSync(inputDir, { recursive: true });
  run('tar', ['-xzf', snapshot, '-C', inputDir]);
  loadInputs();
  appendFileSync(process.env.GITHUB_ENV, `KIMI_CODE_BUILT_IN_CATALOG_FILE=${inputDir}/catalog.json\n`);
} else if (command === 'finish') {
  verifyTag();
  const release = getRelease();
  if (!release.draft) {
    process.exit(0);
  }
  const directory = resolve(process.argv[3] ?? 'dist-native-release');
  const files = {};
  const manifest = json(`${directory}/manifest.json`);
  if (manifest.version !== cli.version || manifest.tag !== tag || JSON.stringify(Object.keys(manifest.platforms).toSorted()) !== JSON.stringify(targets)) throw new Error('Incomplete native manifest');
  for (const target of targets) {
    for (const suffix of ['zip', 'zst', 'tar.gz']) {
      const name = `kimi-code-${target}.${suffix}`;
      const expected = readFileSync(`${directory}/${name}.sha256`, 'utf8').trim().split(/\s+/)[0];
      if (hash(`${directory}/${name}`) !== expected) throw new Error(`Invalid artifact checksum: ${name}`);
      files[name] = hash(`${directory}/${name}`);
      files[`${name}.sha256`] = hash(`${directory}/${name}.sha256`);
    }
  }
  for (const target of targets) {
    if (manifest.platforms[target].compressed?.filename !== `kimi-code-${target}.zst` || manifest.platforms[target].compressed.checksum !== files[`kimi-code-${target}.zst`]) throw new Error(`Manifest checksum mismatch: ${target}`);
  }
  files['manifest.json'] = hash(`${directory}/manifest.json`);
  run('gh', ['release', 'upload', tag, ...Object.keys(files).map(name => `${directory}/${name}`), '--repo', repo, '--clobber']);
  const changelog = readFileSync(`${cli.path}/CHANGELOG.md`, 'utf8');
  const notes = changelog.split(/(?=^## )/m).find(section => section.split(/\r?\n/, 1)[0] === `## ${cli.version}`);
  if (!notes) throw new Error(`Missing changelog: ${tag}`);
  run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--notes-file', '-'], { input: notes });
} else {
  throw new Error(`Unknown command: ${command}`);
}
