import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'pathe';

export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

export function ensureKimiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
