import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface WorkspaceTrustStore {
  list(): readonly string[];
  isTrusted(workDir: string): boolean;
  trust(workDir: string): void;
  untrust(workDir: string): void;
}

export function createWorkspaceTrustStore(homeDir: string): WorkspaceTrustStore {
  const filePath = join(homeDir, 'trusted-workspaces.json');
  const read = (): string[] => {
    if (!existsSync(filePath)) return [];
    try {
      const data: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (!Array.isArray(data)) return [];
      return data.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      return [];
    }
  };
  const write = (entries: readonly string[]): void => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, filePath);
  };
  const normalize = (workDir: string): string => resolve(workDir);
  return {
    list: () => read(),
    isTrusted: (workDir) => {
      const target = normalize(workDir);
      return read().some((entry) => {
        const trusted = normalize(entry);
        return target === trusted || target.startsWith(`${trusted}${sep}`);
      });
    },
    trust: (workDir) => {
      const entries = read();
      const target = normalize(workDir);
      if (entries.some((entry) => normalize(entry) === target)) return;
      write([...entries, target]);
    },
    untrust: (workDir) => {
      const target = normalize(workDir);
      write(read().filter((entry) => normalize(entry) !== target));
    },
  };
}
