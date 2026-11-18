import { homedir } from 'node:os';
import { join } from 'node:path';

export function getShareBinRgPath(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return join(override, 'bin', binaryName('rg'));
  return join(homedir(), '.kimi-code', 'bin', binaryName('rg'));
}

export function getShareBinFdPath(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return join(override, 'bin', binaryName('fd'));
  return join(homedir(), '.kimi-code', 'bin', binaryName('fd'));
}

function binaryName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}
