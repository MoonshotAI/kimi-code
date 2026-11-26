import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_SHARDS = 5;
export const TEST_FILES_PER_SHARD = 320;

export const RUN_ALL = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^vitest\.config\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^build\//,
  /^patches\//,
  /^scripts\/vitest-[^/]+$/,
  /^scripts\/select-vitest-targets\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
];

export const NO_VITEST = [
  /^\.agents\//,
  /^\.changeset\//,
  /^\.github\//,
  /^\.husky\//,
  /^KIMI CODE LOGO\//,
  /^release-notes\//,
  /^scripts\//,
  /^skills\//,
  /^tests\/[^/]+\.(?:md|yaml)$/,
  /^[^/]+\.md$/,
  /^(?:LICENSE|Makefile|flake\.nix|flake\.lock)$/,
  /^\.(?:commentignore|editorconfig|env\.example|gitattributes|gitignore|jscpd\.json|oxfmtrc\.json|oxlintrc\.json|oxlintrc\.ratchet\.json)$/,
];

export const UNDECLARED_READS = [
  { from: /^(?:packages\/|apps\/desktop\/src\/)/, tests: 'packages/app-core/test/shortcutKeySources.test.ts' },
  { from: /^tests\/scenarios\/recordings\//, tests: 'packages/app-core/test/replay/' },
  { from: /^tests\/scenarios\/capabilities\//, tests: 'packages/acp-server/test/kap-parity.test.ts' },
  { from: /^packages\/agent-core-v2\/docs\//, tests: 'apps/vis/web/test/renderers.test.ts' },
  { from: /^packages\/kap-server\/src\//, tests: 'packages/agent-core-v2/test/environment/architectureBoundaries.test.ts' },
];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const TEST_FILE = /\.(?:test|e2e|integration)\.[cm]?tsx?$/;

export function workspacePatterns(yaml) {
  const patterns = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages || /^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
    if (item === null) break;
    patterns.push(item[1]);
  }
  return patterns;
}

export function dependentsOf(manifests) {
  const dirByName = new Map(Object.entries(manifests).map(([dir, manifest]) => [manifest.name, dir]));
  const dependents = new Map(Object.keys(manifests).map(dir => [dir, new Set()]));
  for (const [dir, manifest] of Object.entries(manifests)) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = dirByName.get(name);
        if (dependency !== undefined && dependency !== dir) dependents.get(dependency).add(dir);
      }
    }
  }
  return dependents;
}

export function selectTargets({ changed, dependents }) {
  const packageDirs = [...dependents.keys()].toSorted((a, b) => b.length - a.length);
  const changedDirs = new Set();
  const targets = new Set();
  for (const path of new Set(changed)) {
    if (RUN_ALL.some(pattern => pattern.test(path))) return { mode: 'all', targets: [], reason: `${path} affects every test` };
    for (const read of UNDECLARED_READS) if (read.from.test(path)) targets.add(read.tests);
    const dir = packageDirs.find(candidate => path.startsWith(`${candidate}/`));
    if (dir !== undefined) changedDirs.add(dir);
    else if (!NO_VITEST.some(pattern => pattern.test(path))) {
      return { mode: 'all', targets: [], reason: `${path} is outside the workspace packages and not known to be test-free` };
    }
  }
  const queue = [...changedDirs];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.pop()) ?? []) {
      if (changedDirs.has(dependent)) continue;
      changedDirs.add(dependent);
      queue.push(dependent);
    }
  }
  for (const dir of changedDirs) targets.add(`${dir}/`);
  const sorted = [...targets].toSorted((a, b) => a.localeCompare(b));
  const covered = sorted.filter(target => !sorted.some(other => other !== target && other.endsWith('/') && target.startsWith(other)));
  return { mode: covered.length === 0 ? 'none' : 'some', targets: covered, reason: `${changed.length} changed file(s)` };
}

export function shardCount(testFiles) {
  if (testFiles === 0) return 0;
  return Math.min(MAX_SHARDS, Math.ceil(testFiles / TEST_FILES_PER_SHARD));
}

function readManifests(root) {
  const manifests = {};
  for (const pattern of workspacePatterns(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))) {
    if (pattern.startsWith('!')) continue;
    const dirs = pattern.endsWith('/*')
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern];
    for (const dir of dirs) {
      const manifest = join(root, dir, 'package.json');
      if (existsSync(manifest)) manifests[dir] = JSON.parse(readFileSync(manifest, 'utf8'));
    }
  }
  return manifests;
}

function countTestFiles(path) {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return TEST_FILE.test(path) ? 1 : 0;
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.name !== 'node_modules' && (entry.isDirectory() || TEST_FILE.test(entry.name)))
    .reduce((sum, entry) => sum + countTestFiles(join(path, entry.name)), 0);
}

function changedFiles(root) {
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) return undefined;
  return diff.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function plan(root, pullRequest) {
  const all = { mode: 'all', shards: MAX_SHARDS, targets: [] };
  if (!pullRequest) return { ...all, reason: 'not a pull request' };
  const changed = changedFiles(root);
  if (changed === undefined) return { ...all, reason: 'could not diff the merge commit against its base' };
  const selection = selectTargets({ changed, dependents: dependentsOf(readManifests(root)) });
  if (selection.mode === 'all') return { ...all, reason: selection.reason };
  const counted = selection.targets.map(target => ({ target, files: countTestFiles(join(root, target)) })).filter(entry => entry.files > 0);
  const files = counted.reduce((sum, entry) => sum + entry.files, 0);
  const targets = counted.map(entry => entry.target);
  if (targets.some(target => /\s/.test(target))) return { ...all, reason: 'a selected path contains whitespace' };
  return { mode: files === 0 ? 'none' : 'some', shards: shardCount(files), targets, reason: `${selection.reason}, ${files} test file(s) selected` };
}

function main() {
  const { values } = parseArgs({
    options: {
      'pull-request': { type: 'boolean', default: false },
      summary: { type: 'boolean', default: false },
    },
  });
  const root = fileURLToPath(new URL('../', import.meta.url));
  let result;
  try {
    result = plan(root, values['pull-request']);
  } catch (error) {
    result = { mode: 'all', shards: MAX_SHARDS, targets: [], reason: `the selection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const filters = result.targets.map(target => join(root, target));
  console.log(`Vitest selection: ${result.mode}, ${result.shards} shard(s) (${result.reason})`);
  for (const target of result.targets) console.log(`  ${target}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nshards=${result.shards}\nfilters=${filters.join(' ')}\n`);
  }
  if (values.summary && process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Vitest selection: ${result.mode}`, '', `${result.reason}. Running on ${result.shards} shard(s).`];
    if (result.targets.length > 0) lines.push('', ...result.targets.map(target => `- \`${target}\``));
    if (result.mode !== 'all') lines.push('', 'Run the CI workflow manually on this branch to run every test.');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
