import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestHome } from '@moonshot-ai/testkit/fixtures';

export const RELEASED_PACKAGE = '@moonshot-ai/kimi-code';
export const RELEASED_PROMPT = 'Remember this greeting.';
export const RELEASED_ANSWER = 'Hello from the released writer.';
export const RELEASED_WORKSPACE = 'old-workspace';

const CORPUS_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const DATA_DIR = '{{DATA_DIR}}';
const WORKSPACE = '{{WORKSPACE}}';
const DESCRIPTION_FILES = new Set(['README.md', 'manifest.json']);

export interface CorpusManifest {
  readonly writer: string;
  readonly integrity: string;
  readonly sessionId: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ReleasedCorpus {
  readonly version: string;
  readonly dir: string;
  readonly manifest: CorpusManifest;
}

export interface CapturedPaths {
  readonly dataDir: readonly string[];
  readonly workspace: readonly string[];
}

export function corpusDirectory(version: string): string {
  return join(CORPUS_ROOT, `released-${version}`);
}

export async function releasedCorpora(): Promise<ReleasedCorpus[]> {
  const entries = await readdir(CORPUS_ROOT, { withFileTypes: true });
  const versions = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('released-')).map((entry) => entry.name.slice('released-'.length));
  return Promise.all(versions.toSorted().map(async (version) => {
    const dir = corpusDirectory(version);
    return { version, dir, manifest: JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CorpusManifest };
  }));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function corpusProblems(corpus: ReleasedCorpus): Promise<string[]> {
  const { manifest } = corpus;
  const problems: string[] = [];
  if (manifest.writer !== `${RELEASED_PACKAGE}@${corpus.version}`) problems.push(`writer ${manifest.writer} does not match the directory version ${corpus.version}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity)) problems.push(`integrity ${manifest.integrity} is not an npm sha512 integrity`);
  if (!/^session_[0-9a-f-]+$/.test(manifest.sessionId)) problems.push(`session ID ${manifest.sessionId} is not a session directory name`);
  const present = (await filesUnder(corpus.dir)).filter((file) => !DESCRIPTION_FILES.has(file));
  for (const file of present) if (manifest.files[file] === undefined) problems.push(`${file} is not listed in the manifest`);
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (!present.includes(file)) problems.push(`${file} is listed in the manifest but missing`);
    else if (sha256(await readFile(join(corpus.dir, file), 'utf8')) !== digest) problems.push(`${file} no longer matches its manifest digest`);
  }
  if (!(await filesUnder(corpus.dir)).includes('README.md')) problems.push('README.md is missing');
  return problems;
}

export async function installCorpus(corpus: ReleasedCorpus, home: TestHome): Promise<void> {
  for (const file of Object.keys(corpus.manifest.files)) {
    const template = await readFile(join(corpus.dir, file), 'utf8');
    const target = join(home.dataDir, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, template.replaceAll(DATA_DIR, () => jsonText(home.dataDir)).replaceAll(WORKSPACE, () => jsonText(home.workspace)));
  }
}

export function templateOf(content: string, paths: CapturedPaths): string {
  const replacements = [
    ...paths.dataDir.map((path) => [jsonText(path), DATA_DIR] as const),
    ...paths.workspace.map((path) => [jsonText(path), WORKSPACE] as const),
  ].toSorted(([a], [b]) => b.length - a.length);
  return replacements.reduce((text, [path, placeholder]) => text.replaceAll(path, placeholder), content);
}

function jsonText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')).toSorted();
}
