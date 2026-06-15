import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = import.meta.dirname && dirname(import.meta.dirname);
const outDir = join(appRoot, 'dist', 'npm-package');

const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf-8'));

function copyEntry(sourceRelativePath) {
  const sourcePath = join(appRoot, sourceRelativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`npm package source does not exist: ${sourceRelativePath}`);
  }
  cpSync(sourcePath, join(outDir, sourceRelativePath), { recursive: true });
}

function copyDistArtifacts() {
  const distPath = join(appRoot, 'dist');
  const skip = new Set(['npm-package']);
  for (const entry of readdirSync(distPath, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    copyEntry(join('dist', entry.name));
  }
}

export function createPublishPackageJson() {
  const scripts = {};
  if (typeof packageJson.scripts?.postinstall === 'string') {
    scripts.postinstall = packageJson.scripts.postinstall;
  }

  const publishConfig = { ...packageJson.publishConfig };
  delete publishConfig.directory;

  return {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    license: packageJson.license,
    author: packageJson.author,
    homepage: packageJson.homepage,
    repository: packageJson.repository,
    bugs: packageJson.bugs,
    keywords: packageJson.keywords,
    bin: packageJson.bin,
    files: packageJson.files,
    type: packageJson.type,
    publishConfig,
    scripts,
    optionalDependencies: packageJson.optionalDependencies,
    engines: packageJson.engines,
  };
}

const isDirectRun = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  copyDistArtifacts();
  copyEntry('scripts/postinstall.mjs');
  copyEntry('scripts/postinstall');
  copyEntry('README.md');

  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify(createPublishPackageJson(), null, 2)}\n`,
  );

  console.log(`npm package prepared: ${relative(appRoot, outDir)}`);
}
