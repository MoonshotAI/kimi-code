#!/usr/bin/env node
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'acorn';

import { extractZip } from './zip.mjs';
import {
  defaultVsixOutputDir,
  extensionRoot,
  isMainModule,
  normalizeVsixTargets,
  vsixFileName,
} from './vsix-targets.mjs';

const REQUIRED_WEBVIEW_FILES = [
  'dist/webview.js',
  'dist/kimi-banner-dark.svg',
  'dist/kimi-banner-light.svg',
  'dist/kimi-logo.png',
];
const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.kimi',
  '.kimi-code',
  '.vscode',
  '__tests__',
  'cache',
  'caches',
  'credentials',
  'logs',
  'node_modules',
  'profile',
  'profiles',
  'runtime',
  'scripts',
  'session',
  'sessions',
  'src',
  'state',
  'states',
  'test',
  'tests',
  'tokens',
  'webview-ui',
]);
const FORBIDDEN_EXTENSIONS = new Set(['.jsonl', '.log', '.map', '.py', '.pyc', '.ts', '.tsx']);
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.svg',
  '.txt',
  '.xml',
]);
const BUILTIN_IMPORTS = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name.slice(5) : `node:${name}`]),
);
// `ws` probes these native accelerators inside try/catch and immediately uses
// its bundled JavaScript fallback when they are absent. They are not required
// runtime dependencies and must not be shipped as cross-platform native code.
const OPTIONAL_FALLBACK_IMPORTS = new Set(['bufferutil', 'canvas', 'utf-8-validate']);
const MANIFEST_FIELDS = [
  'name',
  'publisher',
  'displayName',
  'version',
  'engines',
  'extensionKind',
  'capabilities',
  'activationEvents',
  'main',
  'icon',
];
const CONTRIBUTE_FIELDS = [
  'commands',
  'configuration',
  'keybindings',
  'menus',
  'views',
  'viewsContainers',
];

export async function verifyVsix(vsixPath, target, options = {}) {
  const extractionRoot = await mkdtemp(join(tmpdir(), 'kimi-vsix-audit-'));
  try {
    await extractZip(vsixPath, extractionRoot);
    return await auditExtractedVsix(extractionRoot, target, options);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function auditExtractedVsix(extractionRoot, target, options = {}) {
  const sourceRoot = options.sourceRoot ?? extensionRoot;
  const extensionDir = join(extractionRoot, 'extension');
  const files = await listFiles(extractionRoot);
  const fileSet = new Set(files);

  requireFile(fileSet, 'extension.vsixmanifest');
  requireFile(fileSet, '[Content_Types].xml');
  requireFile(fileSet, 'extension/package.json');
  const packagedManifest = await readJson(join(extensionDir, 'package.json'), 'package.json');
  const sourceManifest = await readJson(join(sourceRoot, 'package.json'), 'source package.json');

  await verifyTargetManifest(extractionRoot, target);
  verifyPackageManifest(packagedManifest, sourceManifest);
  verifyRequiredFiles(fileSet, packagedManifest);
  verifyForbiddenFiles(files);
  await verifyNoSensitiveContent(extractionRoot, files, sourceRoot, options.forbiddenText ?? []);
  await verifyRuntimeImports(extensionDir, files);
  await verifyEntryImport(extensionDir, packagedManifest.main);

  const bytes = await totalSize(extractionRoot, files);
  return { target, files: files.length, bytes };
}

async function verifyTargetManifest(extractionRoot, target) {
  const xml = await readFile(join(extractionRoot, 'extension.vsixmanifest'), 'utf8');
  const actual = xml.match(/\bTargetPlatform="([^"]+)"/)?.[1];
  if (actual !== target) {
    throw new Error(
      `VSIX manifest target is ${actual ?? 'missing'}, expected ${target}.`,
    );
  }
}

function verifyPackageManifest(packaged, source) {
  if (typeof packaged.main !== 'string' || !packaged.main.endsWith('.js')) {
    throw new Error(`Packaged extension main must be a .js entry, got ${String(packaged.main)}.`);
  }
  if (packaged.main !== './dist/extension.js') {
    throw new Error(`Packaged extension main is ${packaged.main}, expected ./dist/extension.js.`);
  }

  for (const field of MANIFEST_FIELDS) {
    if (!isDeepStrictEqual(packaged[field], source[field])) {
      throw new Error(`Packaged package.json field "${field}" does not match the source manifest.`);
    }
  }
  for (const field of CONTRIBUTE_FIELDS) {
    if (!isDeepStrictEqual(packaged.contributes?.[field], source.contributes?.[field])) {
      throw new Error(
        `Packaged package.json contributes.${field} does not match the source manifest.`,
      );
    }
  }
}

function verifyRequiredFiles(fileSet, manifest) {
  const required = [
    'extension/LICENSE.txt',
    `extension/${stripLeadingDotSlash(manifest.main)}`,
    ...REQUIRED_WEBVIEW_FILES.map((file) => `extension/${file}`),
  ];
  requireOneOf(fileSet, ['extension/README.md', 'extension/readme.md'], 'marketplace README');
  if (typeof manifest.icon === 'string') required.push(`extension/${manifest.icon}`);

  for (const container of Object.values(manifest.contributes?.viewsContainers ?? {})) {
    if (!Array.isArray(container)) continue;
    for (const view of container) {
      if (typeof view?.icon === 'string') required.push(`extension/${view.icon}`);
    }
  }
  for (const file of required) requireFile(fileSet, file);
}

function verifyForbiddenFiles(files) {
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const lower = normalized.toLowerCase();
    const extensionRelative = lower.startsWith('extension/') ? lower.slice('extension/'.length) : lower;
    const segments = extensionRelative.split('/');
    const forbiddenSegment = segments.find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
    if (forbiddenSegment !== undefined) {
      throw new Error(`Forbidden package path segment "${forbiddenSegment}" in ${normalized}.`);
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(lower))) {
      throw new Error(`Forbidden package file type in ${normalized}.`);
    }
    if (
      lower.includes('kimi-agent-sdk') ||
      lower.includes('download-cli') ||
      lower.includes('/bin/kimi/') ||
      /(^|\/)uv(?:\.exe)?$/.test(lower)
    ) {
      throw new Error(`Legacy CLI/runtime artifact found in ${normalized}.`);
    }
  }
}

async function verifyNoSensitiveContent(extractionRoot, files, sourceRoot, extraForbiddenText) {
  const secretValues = [process.env.VSCE_PAT, process.env.OVSX_PAT]
    .filter((value) => typeof value === 'string' && value.length >= 8);
  const forbidden = [sourceRoot, homedir(), ...extraForbiddenText, ...secretValues]
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .flatMap((value) => [value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')]);

  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(join(extractionRoot, file), 'utf8');
    const match = forbidden.find((value) => content.includes(value));
    if (match === undefined) continue;
    const label = secretValues.includes(match) ? 'a marketplace token' : 'a local filesystem path';
    throw new Error(`Packaged text file ${file} contains ${label}.`);
  }
}

async function verifyRuntimeImports(extensionDir, files) {
  const distFiles = files.filter(
    (file) => file.startsWith('extension/dist/') && ['.cjs', '.js', '.mjs'].includes(extname(file)),
  );
  if (distFiles.length === 0) throw new Error('No JavaScript extension bundle files were packaged.');

  for (const archivePath of distFiles) {
    const localPath = join(dirname(extensionDir), archivePath);
    const source = await readFile(localPath, 'utf8');
    for (const specifier of collectLiteralImports(source)) {
      if (specifier === 'vscode' || BUILTIN_IMPORTS.has(specifier)) continue;
      if (OPTIONAL_FALLBACK_IMPORTS.has(specifier)) continue;
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        if (specifier.startsWith('/')) {
          throw new Error(`Absolute runtime import "${specifier}" in ${archivePath}.`);
        }
        const dependencyPath = resolve(dirname(localPath), stripImportSuffix(specifier));
        if (!runtimeImportExists(dependencyPath)) {
          throw new Error(`Missing relative runtime import "${specifier}" in ${archivePath}.`);
        }
        continue;
      }
      if (specifier.startsWith('data:') || specifier.startsWith('file:')) continue;
      throw new Error(`Bare runtime dependency "${specifier}" remains in ${archivePath}.`);
    }
  }
}

function collectLiteralImports(source) {
  const imports = new Set();
  const program = parse(source, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  walkSyntax(program, (node) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration'
    ) {
      const specifier = literalString(node.source);
      if (specifier !== undefined) imports.add(specifier);
      return;
    }
    if (node.type === 'ImportExpression') {
      const specifier = literalString(node.source);
      if (specifier !== undefined) imports.add(specifier);
      return;
    }
    if (node.type === 'CallExpression' && isRuntimeRequire(node.callee)) {
      const specifier = literalString(node.arguments?.[0]);
      if (specifier !== undefined) imports.add(specifier);
    }
  });
  return imports;
}

function walkSyntax(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkSyntax(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (typeof value.type === 'string') visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walkSyntax(child, visit);
  }
}

function isRuntimeRequire(callee) {
  if (callee?.type === 'Identifier') return /^(?:__)?require\d*$/.test(callee.name);
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return false;
  return callee.property?.type === 'Identifier' && callee.property.name === 'require';
}

function literalString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value?.cooked;
  }
  return undefined;
}

async function verifyEntryImport(extensionDir, main) {
  const mainPath = join(extensionDir, stripLeadingDotSlash(main));
  const stubDir = join(extensionDir, 'node_modules', 'vscode');
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    join(stubDir, 'package.json'),
    `${JSON.stringify({ name: 'vscode', version: '0.0.0-test', type: 'module', exports: './index.js' }, null, 2)}\n`,
  );
  await writeFile(join(stubDir, 'index.js'), 'export {};\n');

  const script = [
    `const extension = await import(${JSON.stringify(pathToFileURL(mainPath).href)});`,
    'if (typeof extension.activate !== "function") {',
    '  throw new Error("extension bundle does not export activate");',
    '}',
  ].join('\n');
  const env = { ...process.env };
  delete env.NODE_PATH;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: dirname(extensionDir),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  await rm(join(extensionDir, 'node_modules'), { recursive: true, force: true });
  if (result.error !== undefined) {
    throw new Error(`Unable to import the unpacked extension entry: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = conciseProcessError(result.stderr || result.stdout);
    throw new Error(`Unpacked extension entry import failed: ${detail}`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${describeError(error)}`, { cause: error });
  }
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(localPath);
      } else if (entry.isFile()) {
        output.push(relative(root, localPath).split(sep).join('/'));
      } else {
        throw new Error(`Unsupported non-file entry in unpacked VSIX: ${localPath}`);
      }
    }
  }
  await visit(root);
  return output.sort();
}

async function totalSize(root, files) {
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(root, file))).size;
  return bytes;
}

function requireFile(fileSet, file) {
  if (fileSet.has(file)) return;
  throw new Error(`Required VSIX resource is missing: ${file}`);
}

function requireOneOf(fileSet, files, label) {
  if (files.some((file) => fileSet.has(file))) return;
  throw new Error(`Required VSIX resource is missing: ${label} (${files.join(' or ')}).`);
}

function runtimeImportExists(path) {
  return [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, 'index.js')].some(existsSync);
}

function stripImportSuffix(specifier) {
  return specifier.split(/[?#]/, 1)[0];
}

function stripLeadingDotSlash(value) {
  return String(value).replace(/^\.\//, '');
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function conciseProcessError(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-4).join('\n') || 'process exited without an error message';
}

function parseArguments(argv) {
  const targets = [];
  let outputDir = defaultVsixOutputDir;
  let file;
  let directory;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--out-dir') {
      outputDir = requireOptionValue(argv, ++index, '--out-dir');
    } else if (argument === '--target') {
      targets.push(requireOptionValue(argv, ++index, '--target'));
    } else if (argument === '--file') {
      file = requireOptionValue(argv, ++index, '--file');
    } else if (argument === '--directory') {
      directory = requireOptionValue(argv, ++index, '--directory');
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      targets.push(argument);
    }
  }

  if (file !== undefined && directory !== undefined) {
    throw new Error('--file and --directory cannot be used together.');
  }
  const normalizedTargets = normalizeVsixTargets(targets);
  if ((file !== undefined || directory !== undefined) && normalizedTargets.length !== 1) {
    throw new Error('--file and --directory require exactly one target.');
  }
  return { targets: normalizedTargets, outputDir: resolve(outputDir), file, directory, help };
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (value !== undefined && !value.startsWith('-')) return value;
  throw new Error(`${option} requires a value.`);
}

function usage() {
  return [
    'Usage: node scripts/vsix-verify.mjs [targets...] [--out-dir <directory>]',
    '       node scripts/vsix-verify.mjs --target <target> --file <file.vsix>',
    '       node scripts/vsix-verify.mjs --target <target> --directory <unpacked-vsix>',
    '',
    'The verifier performs a package-content audit and an entry import smoke only.',
    'It does not claim that a target passed a real operating-system E2E run.',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  for (const target of options.targets) {
    const input = options.directory ?? options.file ?? join(options.outputDir, vsixFileName(target));
    const result = options.directory === undefined
      ? await verifyVsix(resolve(input), target, { sourceRoot: extensionRoot })
      : await auditExtractedVsix(resolve(input), target, { sourceRoot: extensionRoot });
    console.log(
      `Verified ${target}: ${result.files} files, ${result.bytes} unpacked bytes; static audit and entry import smoke passed (package-only).`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`VSIX verification failed: ${describeError(error)}`);
    process.exitCode = 1;
  });
}
