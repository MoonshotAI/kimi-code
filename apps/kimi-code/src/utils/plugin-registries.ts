import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface PluginRegistry {
  readonly name?: string;
  readonly url: string;
}

export interface RegistriesFile {
  readonly version: 1;
  readonly registries: PluginRegistry[];
}

const REGISTRIES_REL = join('plugins', 'registries.json');

export async function readRegistries(kimiHomeDir: string): Promise<RegistriesFile> {
  const filePath = join(kimiHomeDir, REGISTRIES_REL);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, registries: [] };
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRegistriesFile(parsed)) {
    throw new Error(`${filePath} is not a valid registries file`);
  }
  return parsed;
}

export async function writeRegistries(
  kimiHomeDir: string,
  data: RegistriesFile,
): Promise<void> {
  const dir = join(kimiHomeDir, 'plugins');
  await mkdir(dir, { recursive: true });
  const final = join(kimiHomeDir, REGISTRIES_REL);
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, final);
}

export async function addRegistry(
  kimiHomeDir: string,
  registry: PluginRegistry,
): Promise<void> {
  const trimmedUrl = registry.url.trim();
  if (trimmedUrl.length === 0) throw new Error('Registry URL cannot be empty');
  const file = await readRegistries(kimiHomeDir);
  if (file.registries.some((r) => r.url === trimmedUrl)) {
    throw new Error(`Registry URL is already registered: ${trimmedUrl}`);
  }
  const trimmedName = registry.name?.trim();
  if (trimmedName !== undefined && trimmedName.length > 0) {
    if (file.registries.some((r) => r.name === trimmedName)) {
      throw new Error(`Registry name is already registered: ${trimmedName}`);
    }
  }
  const next: RegistriesFile = {
    ...file,
    registries: [
      ...file.registries,
      {
        url: trimmedUrl,
        name: trimmedName || undefined,
      },
    ],
  };
  await writeRegistries(kimiHomeDir, next);
}

export async function removeRegistry(
  kimiHomeDir: string,
  nameOrUrl: string,
): Promise<void> {
  const key = nameOrUrl.trim();
  if (key.length === 0) throw new Error('Registry name or URL cannot be empty');
  const file = await readRegistries(kimiHomeDir);
  const byNameIndex = file.registries.findIndex((r) => r.name === key);
  const byUrlIndex = file.registries.findIndex((r) => r.url === key);
  const index = byNameIndex !== -1 ? byNameIndex : byUrlIndex;
  if (index === -1) throw new Error(`Registry not found: ${key}`);
  const next = {
    ...file,
    registries: file.registries.filter((_, i) => i !== index),
  };
  await writeRegistries(kimiHomeDir, next);
}

export async function resolveRegistryUrl(
  kimiHomeDir: string,
  nameOrUrl: string,
): Promise<string> {
  const key = nameOrUrl.trim();
  if (key.length === 0) throw new Error('Registry name or URL cannot be empty');
  if (isUrlLike(key)) return key;
  const file = await readRegistries(kimiHomeDir);
  const found = file.registries.find((r) => r.name === key);
  if (found === undefined) throw new Error(`Registry not found: ${key}`);
  return found.url;
}

function isRegistriesFile(value: unknown): value is RegistriesFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['version'] === 1 &&
    Array.isArray(obj['registries']) &&
    obj['registries'].every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>)['url'] === 'string',
    )
  );
}

function isUrlLike(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value === '~' ||
    value.startsWith('~/') ||
    isAbsolute(value)
  );
}
