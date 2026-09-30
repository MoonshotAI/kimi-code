import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveKimiHome(
  homeDir?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  osHomeDir: string = homedir(),
): string {
  return homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string;
  readonly configPath?: string;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

export function sanitizeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = base.replaceAll(/[^A-Za-z0-9]+/g, '-').replaceAll(/(?:^-+)|(?:-+$)/g, '');
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${slug.length > 0 ? slug : 'workspace'}-${hash}`;
}
