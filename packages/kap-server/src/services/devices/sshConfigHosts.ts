import { basename, dirname, isAbsolute, join } from 'node:path';

import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2';

export interface SshConfigHost {
  readonly alias: string;
  readonly hostName?: string;
  readonly user?: string;
  readonly port?: number;
}

export interface SshConfigHosts {
  readonly configPath: string;
  readonly exists: boolean;
  readonly hosts: readonly SshConfigHost[];
}

const MAX_INCLUDE_DEPTH = 16;

interface MutableHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
}

export async function readSshConfigHosts(
  fs: Pick<IHostFileSystem, 'readText' | 'readdir'>,
  homeDir: string,
): Promise<SshConfigHosts> {
  const sshDir = join(homeDir, '.ssh');
  const configPath = join(sshDir, 'config');
  const hosts = new Map<string, MutableHost>();
  const visited = new Set<string>();
  let exists = true;

  const readFile = async (path: string): Promise<string | undefined> => {
    try {
      return await fs.readText(path);
    } catch {
      return undefined;
    }
  };

  const expandInclude = async (pattern: string): Promise<string[]> => {
    const expanded = pattern.startsWith('~/') ? join(homeDir, pattern.slice(2)) : pattern;
    const path = isAbsolute(expanded) ? expanded : join(sshDir, expanded);
    const name = basename(path);
    if (!/[*?]/.test(name)) return [path];
    if (/[*?]/.test(dirname(path))) return [];
    const matcher = globMatcher(name);
    try {
      const entries = await fs.readdir(dirname(path));
      return entries
        .filter((entry) => !entry.isDirectory && matcher.test(entry.name))
        .map((entry) => join(dirname(path), entry.name))
        .toSorted();
    } catch {
      return [];
    }
  };

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH || visited.has(path)) return;
    visited.add(path);
    const text = await readFile(path);
    if (text === undefined) {
      if (depth === 0) exists = false;
      return;
    }
    let current: MutableHost[] = [];
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed === undefined) continue;
      const [keyword, args] = parsed;
      if (keyword === 'include') {
        for (const pattern of args) {
          for (const included of await expandInclude(pattern)) await visit(included, depth + 1);
        }
        continue;
      }
      if (keyword === 'match') {
        current = [];
        continue;
      }
      if (keyword === 'host') {
        current = [];
        for (const alias of args) {
          if (/[*?!]/.test(alias)) continue;
          let host = hosts.get(alias);
          if (host === undefined) {
            host = { alias };
            hosts.set(alias, host);
          }
          current.push(host);
        }
        continue;
      }
      const value = args[0];
      if (value === undefined) continue;
      for (const host of current) {
        if (keyword === 'hostname') host.hostName ??= value;
        else if (keyword === 'user') host.user ??= value;
        else if (keyword === 'port') {
          const port = Number.parseInt(value, 10);
          if (Number.isInteger(port) && port > 0 && port < 65536) host.port ??= port;
        }
      }
    }
  };

  await visit(configPath, 0);
  return { configPath, exists, hosts: [...hosts.values()] };
}

function parseLine(line: string): [string, string[]] | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  const match = /^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/.exec(trimmed);
  if (match === null) return undefined;
  const args: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (let token = pattern.exec(match[2]!); token !== null; token = pattern.exec(match[2]!)) {
    if (token[2]?.startsWith('#')) break;
    args.push(token[1] ?? token[2]!);
  }
  return [match[1]!.toLowerCase(), args];
}

function globMatcher(glob: string): RegExp {
  const source = glob.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${source}$`);
}
